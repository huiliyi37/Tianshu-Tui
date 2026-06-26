import { readFileSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { z } from 'zod'
import type { CoordinatorRun, DelegationRequest } from '../agent/coordinator.js'
import { createCoordinatorReviewDeps } from '../agent/review-coordinator-deps.js'
import { classifyChangeScale, isCrossModule, isFixContext, type ChangeSet, type ReviewScale } from '../agent/review-discipline.js'
import { classifyOrchestrationScale } from '../agent/task-size-gate.js'
import { routeReviewWorkflow } from '../agent/review-router.js'
import { extractChangedFiles } from '../agent/diff-collector.js'
import { runTeamSkeleton, type TeamRunSummary } from '../agent/team-orchestrator.js'
import type { TeamTask } from '../agent/team-plan.js'
import { deserializeUnifiedPlan, unifiedPlanToTeamTasks, validateUnifiedPlan } from '../agent/unified-plan.js'
import { buildHistoricalTeamSchedulerState, type TeamSchedulerBanditState } from '../agent/team-scheduler-bandit.js'
import type { TeamSchedulerShadowEvent } from '../agent/team-scheduler-shadow.js'
import { persistGatedInfluenceAudit, type GatedInfluenceAuditEvent } from '../agent/gated-influence-audit.js'
import { buildTeamEpisodeFromStore, recordTeamEpisodeClosureFromStore } from '../agent/reward-loop.js'
import { formatTeamDelivery } from '../agent/team-episode.js'
import type { TeamWaveTelemetry } from '../agent/team-wave-telemetry.js'
import { buildTeamWaveScopeHealth, persistTeamScopeHealth } from '../agent/team-scope-health.js'
import { buildTeamPanelModel, encodeTeamPanelModel } from '../tui/team-panel-model.js'
import type { AggregationPolicy } from '../agent/work-order.js'
import { validatePathSafe } from './path-validate.js'
import { createActivityStreamer, activityProgressLine } from './worker-activity-stream.js'
import type { WorkerActivityEvent } from '../agent/coordinator.js'
import type { Tool, ToolCallParams, ToolResult } from './types.js'
// Cross-layer: the tool layer consumes the meridian data layer (independent
// graph store) for advisory blast-radius hints. Same direction as
// createRepoGraphTool(() => refs.meridianIndexer) in bootstrap.
import type { ImpactResult } from '../repo/meridian-impact.js'
import { runChangedFilesTypecheckMemo, typecheckGateEnabled } from '../agent/typecheck-gate.js'

/** Narrow surface for meridian structural impact analysis, so tests can mock it
 *  without the full MeridianIndexer. MeridianIndexer satisfies this structurally. */
export interface TeamImpactAnalyzer {
  impact(changedFiles: string[], opts?: { maxHops?: number }): ImpactResult
}

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
  /** Optional meridian indexer for advisory blast-radius hints in the review gate. */
  getMeridianIndexer?: () => TeamImpactAnalyzer | null | undefined
  /** Optional injectable typecheck runner for the review-gate backstop.
   *  Absent → the real `tsc --noEmit` is used. Tests pass a mock. */
  getTypecheckRunner?: () => import('../agent/typecheck-gate.js').TypecheckRunner | undefined
}

/** Join a list, truncating to `n` entries with a trailing elision count so a
 *  large blast radius doesn't flood the review focus / returned content. */
function capList(items: string[], n = 8): string {
  return items.length <= n ? items.join(', ') : `${items.slice(0, n).join(', ')} (+${items.length - n} more)`
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

/**
 * Render the council merge ledger (max mode, first wave) so the perspective work
 * isn't silently dropped: cross-perspective conflicts, deferred alternatives, and
 * the risk ledger. Each section is capped to keep the panel readable; a trailing
 * count signals how many were elided. Advisory — never blocks dispatch.
 */
function formatPlanMerge(planMerge: NonNullable<TeamRunSummary['planMerge']>): string[] {
  const CAP = 3
  const lines: string[] = []
  const section = (
    title: string,
    items: string[],
  ): void => {
    if (items.length === 0) return
    lines.push(title)
    for (const item of items.slice(0, CAP)) lines.push(`  - ${item}`)
    if (items.length > CAP) lines.push(`  … (+${items.length - CAP} more)`)
  }
  section(
    'Plan conflicts (council disagreed — adjudicate):',
    planMerge.conflicts.map(c => c.description),
  )
  section(
    'Deferred alternatives (not in base plan):',
    planMerge.deferred.map(d => `${d.title} — ${d.reason}`),
  )
  section(
    'Risk ledger:',
    planMerge.risks.map(r => `[${r.severity}]${r.taskId ? ` ${r.taskId}:` : ''} ${r.claim}`),
  )
  return lines
}

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
  if (summary.planMerge) {
    const mergeLines = formatPlanMerge(summary.planMerge)
    if (mergeLines.length > 0) lines.push('', ...mergeLines)
  }
  const nextWave = fromWave + 1
  if (summary.waves.length > nextWave) {
    // Whole-wave failure: every worker missed its bar. Advancing on top of a
    // failed/stale wave compounds breakage, so replace the next-wave nudge with
    // a stop warning. Only triggers when an actual run is present (post-dispatch),
    // not for the onPlanReady pre-render where summary.run is absent.
    const run = summary.run
    const allFailed = !!run && run.results.length > 0 && run.results.every(r => r.status !== 'passed')
    if (allFailed) {
      lines.push('', `⚠ wave ${fromWave}: all ${run!.results.length} workers failed — integrate/retry before advancing; do NOT dispatch fromWave ${nextWave} until fixed.`)
    } else {
      lines.push('', `To run the next wave after integrating this wave's diffs: call team_orchestrate again with fromWave: ${nextWave}.`)
    }
  }
  lines.push('', summary.packet)
  return lines.join('\n')
}

/**
 * Authoritative changed-file list for the review gate. Worker `changedFiles` is
 * model self-reported and can be empty even when real edits happened — a worker
 * that under-reports would silently skip the whole review gate. The diff artifact
 * (`kind:'diff'`, produced by hands-session collectDiff) carries the real file
 * list, so we union diff-derived files with the self-report.
 */
export function teamReviewChangedFiles(run: TeamRunSummary['run']): string[] {
  if (!run) return []
  const files = new Set<string>()
  for (const result of run.results) {
    for (const file of result.changedFiles) files.add(file)
    for (const artifact of result.artifacts) {
      if (artifact.kind === 'diff') {
        for (const file of extractChangedFiles(artifact.content)) files.add(file)
      }
    }
  }
  return [...files]
}

/**
 * Force the perspective-layer density that flash execution lacks.
 *  - max mode → always L3 (the full 5-inspector squadron), regardless of size.
 *  - standard mode → raise the floor to ≥L2 (no silent L1 nudge), and upgrade
 *    to L3 on structural risk signals (cross-module / ≥3 tasks in the wave /
 *    any high-risk task). classifyChangeScale already returns L3 for
 *    cross-module/≥5 files/security boundary; this only raises, never lowers.
 */
export function teamReviewForceLevel(
  mode: 'standard' | 'max',
  change: ChangeSet,
  waveTasks: TeamTask[],
): ReviewScale {
  if (mode === 'max') return 'L3'
  const base = classifyChangeScale(change)
  const hasHighRisk = waveTasks.some(task => task.riskTier === 'high')
  if (base === 'L3' || change.crossModule || waveTasks.length >= 3 || hasHighRisk) return 'L3'
  return base === 'L1' ? 'L2' : base
}

/**
 * Turn the merged plan's per-task verification gates into a reviewer focus hint,
 * so the squadron/verifier checks the acceptance criteria the planners defined
 * rather than guessing. Empty when no verification was planned.
 */
export function teamReviewFocusHint(waveTasks: TeamTask[]): string | undefined {
  const gates = [...new Set(waveTasks.flatMap(task => task.verification).map(v => v.trim()).filter(Boolean))]
  if (gates.length === 0) return undefined
  return `Planned acceptance gates (verify these, do not just trust green): ${gates.join('; ')}`
}

export function createTeamOrchestrateTool(
  coordinator: TeamOrchestrateCoordinator,
  options?: { defaultMaxParallel?: number },
): Tool {
  // Cache prior wave results for cross-wave failure propagation.
  // Set after each dispatch; read when fromWave > 0.
  let priorWaveResults: import('../agent/work-order.js').WorkerResult[] | undefined

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

      // Task-size gate: block small tasks from triggering heavy orchestration
      const scale = classifyOrchestrationScale(objective)
      if (scale.blocked) {
        return {
          content: `team_orchestrate blocked: ${scale.reason}\n\nDo this task inline instead — it doesn't need parallel orchestration.\n(To bypass: prefix the objective with "force:")`,
          isError: true,
        }
      }

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
            // Cross-wave failure propagation: pass prior wave results so
            // dispatchWaveAt can block tasks whose dependencies failed.
            priorResults: (fromWave ?? 0) > 0 ? priorWaveResults : undefined,
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

      // Cache this wave's results for cross-wave failure propagation.
      // The next call with fromWave+1 will pass these as priorResults.
      if (summary.run?.results) {
        priorWaveResults = summary.run.results
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
      let impactNote = ''
      let reviewVerdict: string | undefined
      const effectiveFromWave = fromWave ?? 0
      const isLastWave = summary.waves.length > 0 && effectiveFromWave >= summary.waves.length - 1

      // Scope-health (advisory): the real diff is already in telemetry's
      // observedChangedFiles. Compare it against planned.files to detect scope
      // leak (worker touched files outside the plan) and missing coverage.
      // Persist for learning, surface medium/high, and feed leaked files to the
      // review focus so the squadron names unplanned changes. Never blocks.
      let scopeHealthNote = ''
      let scopeLeakedFiles: string[] = []
      if (telemetryEvent) {
        try {
          const health = buildTeamWaveScopeHealth(telemetryEvent)
          const rewardStore = coordinator.getTeamSchedulerRewardStore?.()
          persistTeamScopeHealth(
            rewardStore?.saveBanditState ? { saveBanditState: rewardStore.saveBanditState.bind(rewardStore) } : undefined,
            health,
          )
          if (health.severity === 'medium' || health.severity === 'high') {
            scopeLeakedFiles = health.leakedFiles
            const parts: string[] = []
            if (health.leakedFiles.length > 0) parts.push(`leaked (changed, not planned): ${health.leakedFiles.join(', ')}`)
            if (health.missingFiles.length > 0) parts.push(`missing (planned, untouched): ${health.missingFiles.join(', ')}`)
            scopeHealthNote = `\n\nScope health [${health.severity}]: ${parts.join('; ')}`
          }
        } catch {
          // Scope health is advisory; never affect dispatch or review.
        }
      }

      // Authoritative changed files: union of real diff artifact + self-report,
      // so a worker that under-reports changedFiles can't skip the review gate.
      const changedFiles = teamReviewChangedFiles(summary.run)
      // reviewDepth guard: prevent review workers from recursively triggering
      // team_orchestrate's own review path. Matches deliver-task.ts convention.
      if (isLastWave && changedFiles.length > 0 && (params.reviewDepth ?? 0) === 0) {
        try {
          const delegate = requireDelegate(coordinator)
          // Resolve this wave's tasks to drive perspective density + focus.
          const taskById = new Map(summary.tasks.map(task => [task.id, task]))
          const waveTasks = (summary.waves[effectiveFromWave]?.taskIds ?? [])
            .map(id => taskById.get(id))
            .filter((task): task is TeamTask => Boolean(task))
          const change: ChangeSet = {
            files: changedFiles,
            crossModule: isCrossModule(changedFiles),
            isFix: isFixContext(objective),
          }
          // Inject the dense perspective layer flash execution lacks.
          change.forceLevel = teamReviewForceLevel(mode, change, waveTasks)
          // Combine planned acceptance gates with scope-leak callouts so the
          // reviewer scrutinizes both the criteria and any unplanned changes.
          const baseFocus = teamReviewFocusHint(waveTasks)
          // Advisory blast radius (meridian): pull structural downstream
          // consumers + related tests for the changed files so the reviewer
          // checks they aren't broken. Input is the diff-derived
          // observedChangedFiles (guaranteed repo-relative, same field
          // scope-health uses) — NOT worker self-report, which may be absolute
          // and would silently miss the repo-relative LIKE match. Never blocks;
          // any failure is swallowed. Only injected at the terminal-wave review
          // (this branch only runs when isLastWave).
          let impactFocus: string | undefined
          try {
            const analyzer = coordinator.getMeridianIndexer?.()
            const observed = (telemetryEvent?.changedFiles.observedChangedFiles ?? []).filter(f => !isAbsolute(f))
            if (analyzer && observed.length > 0) {
              const impact = analyzer.impact(observed)
              const consumers = [...impact.direct, ...impact.transitive]
              const seg: string[] = []
              if (consumers.length > 0) seg.push(`downstream consumers (verify not broken): ${capList(consumers)}`)
              if (impact.tests.length > 0) seg.push(`related tests to run: ${capList(impact.tests)}`)
              if (seg.length > 0) {
                impactFocus = `Blast radius — ${seg.join('; ')}`
                impactNote = `\n\nBlast radius [meridian]: ${seg.join('; ')}`
              }
            }
          } catch {
            // Impact hints are advisory; never affect dispatch or review.
          }
          // Typecheck backstop (Component B) — scoped tsc on the diff-derived
          // changed files; a real type error that tests/esbuild missed escalates
          // the review to L3 and is surfaced FIRST (more urgent than blast
          // radius). Advisory: any failure is swallowed; never blocks dispatch.
          // Covers both scoped errors (in changed files) and cross-file drift
          // (new errors in non-changed files from definition changes).
          let typecheckFocus: string | undefined
          const typecheckRunner = coordinator.getTypecheckRunner?.()
          // Require an explicitly-wired runner here (bootstrap injects the real
          // tsc). Unlike deliver-task, the team gate runs in the coordinator
          // session at process.cwd(), so we never fall back to a default that
          // would spawn an unscoped tsc in tests / unwired contexts.
          if (typecheckGateEnabled() && typecheckRunner) {
            try {
              const observed = (telemetryEvent?.changedFiles.observedChangedFiles ?? []).filter(f => !isAbsolute(f))
              const tc = runChangedFilesTypecheckMemo(params.cwd, observed, typecheckRunner)
              if (tc) {
                change.forceLevel = 'L3'
                typecheckFocus = `Typecheck — ${tc.summary}`
                impactNote = `\n\nTypecheck broken [tsc]: ${tc.summary}` + impactNote
              }
            } catch {
              // Typecheck gate is advisory; never affect dispatch or review.
            }
          }
          const focusParts = [
            typecheckFocus,
            baseFocus,
            scopeLeakedFiles.length > 0
              ? `Scope leak — files changed outside the plan, scrutinize these: ${scopeLeakedFiles.join(', ')}`
              : undefined,
            impactFocus,
          ].filter((s): s is string => Boolean(s))
          const focusHint = focusParts.length > 0 ? focusParts.join(' | ') : undefined
          const reviewDeps = createCoordinatorReviewDeps(
            {
              delegate: (request, abortSignal) => delegate(request, abortSignal),
              delegateBatch: (requests, policy, abortSignal, onProgress) =>
                coordinator.delegateBatch(requests, policy, abortSignal, onProgress),
            },
            { reviewDepth: params.reviewDepth ?? 0, abortSignal: params.abortSignal, parentTurnId: `${params.toolUseId}:review` },
          )
          const outcome = await routeReviewWorkflow(change, reviewDeps, { maxRounds: 3, ...(focusHint ? { focusHint } : {}) })
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
        content: formatTeamSummary(summary, effectiveFromWave) + reviewNote + scopeHealthNote + impactNote + deliverySynthesis,
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
