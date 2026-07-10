import { readFileSync } from 'node:fs'
import { z } from 'zod'
import { classifyOrchestrationScale } from '../agent/task-size-gate.js'
import type { TeamRunSummary } from '../agent/team-orchestrator.js'
import { deserializeUnifiedPlan, unifiedPlanToTeamTasks, validateUnifiedPlan } from '../agent/unified-plan.js'
import { clearPlan, consumePlan, storePlan } from '../agent/plan-store.js'
import { buildTeamPanelModel, encodeTeamPanelModel } from '../tui/team-panel-model.js'
import { validatePathSafe } from './path-validate.js'
import { createActivityStreamer, createDelegationActivityMapper } from './worker-activity-stream.js'
import type { WorkerActivityEvent } from '../agent/coordinator.js'
import type { Tool, ToolCallParams, ToolResult } from './types.js'
// Shared execution kernel — the dispatch + scope-health + review gate + telemetry
// closure live in the agent layer so plan_task and team_orchestrate share one path.
import {
  executePlan,
  teamReviewChangedFiles,
  teamReviewForceLevel,
  teamReviewFocusHint,
  type PlanExecutorDeps,
  type PlanExecutorRun,
  type TeamImpactAnalyzer,
} from '../agent/plan-executor.js'

// Back-compat re-exports: TeamOrchestrateCoordinator was the tool-layer name for
// the executor's dependency surface; tests/bootstrap still reference these and the
// review helpers from this module.
export type TeamOrchestrateCoordinator = PlanExecutorDeps
export type { TeamImpactAnalyzer }
export { teamReviewChangedFiles, teamReviewForceLevel, teamReviewFocusHint }

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
    '已补入执行图的分片 (orthogonal shards folded in):',
    planMerge.augmented.map(a => `${a.title} — ${a.reason}`),
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
  if (summary.advisories && summary.advisories.length > 0) {
    lines.push('', '分片建议(不阻断):')
    for (const a of summary.advisories.slice(0, 3)) lines.push(`  - ${a}`)
    if (summary.advisories.length > 3) lines.push(`  … (+${summary.advisories.length - 3} more)`)
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

export function createTeamOrchestrateTool(
  coordinator: TeamOrchestrateCoordinator,
  options?: {
    defaultMaxParallel?: number
    /** Pro gate: mode:'max'（多视角 planner fanout）仅 Pro 可用。缺省 true
     *  以保持直接构造方（测试等）行为不变；bootstrap 按 pro-license 传真值。 */
    teamMaxEnabled?: boolean
  },
): Tool {
  return {
    definition: {
      name: 'team_orchestrate',
      description:
        'Run the deterministic team orchestrator: parse a plan (standard), group tasks into waves respecting file conflicts and dependencies, and dispatch the first ready wave of workers. Returns the wave schedule and dispatch summary. Does NOT auto-commit.\n\nSHARDING: split the work HORIZONTALLY into orthogonal shards — each a complete, self-contained unit (implement + run tsc/lint/relevant tests) owned end-to-end by ONE capable flash. Do NOT split vertically by stage (no separate lint/type/import/test role tasks). Keep shards on disjoint files so they run in parallel; when two shards must touch the same file, set dependsOn to order them (the validator warns about overlap without ordering). Workers write directly into the controller\'s single shared workspace — there are no per-worker diffs to merge; review the aggregate with git diff.\n\nPass planJson (UnifiedPlan from plan_task) to skip Markdown/planner fanout and execute directly.',
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
      const { mode, objective, planPath, planMarkdown, planJson: explicitPlanJson, maxParallel, fromWave } = parsed.data
      // Bridge: auto-consume the plan stored by plan_task when planJson is omitted.
      const planJson = explicitPlanJson ?? consumePlan(params.sessionId)
      // Stale-plan hygiene: an explicit planJson takes priority, so drop any plan
      // left in the session store — otherwise it would be wrongly auto-consumed by
      // a later bare call.
      if (explicitPlanJson) clearPlan(params.sessionId)

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
      let planAdvisoryNote = ''
      if (planJson) {
        const plan = deserializeUnifiedPlan(planJson)
        if (!plan) return { content: 'team_orchestrate blocked: planJson is not a valid UnifiedPlan', isError: true }
        const validation = validateUnifiedPlan(plan)
        if (!validation.valid) {
          const errors = [...validation.errors, ...validation.nodeErrors.map(ne => `[${ne.nodeId}] ${ne.error}`)]
          return { content: `team_orchestrate blocked: plan validation failed:\n${errors.map(e => `  - ${e}`).join('\n')}`, isError: true }
        }
        if (validation.warnings.length > 0) {
          planAdvisoryNote = `\n\n分片建议(不阻断):\n${validation.warnings.map(w => `  - ${w}`).join('\n')}`
        }
        tasks = unifiedPlanToTeamTasks(plan)
        // Re-store for multi-wave: consumePlan cleared it, but subsequent
        // waves need it too.  Only re-store when the model didn't pass an
        // explicit planJson (explicit always takes priority).
        if (!explicitPlanJson) storePlan(planJson, params.sessionId)
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

      // ── Pro gate: team max ──
      // 多视角 planner fanout 是 Pro 功能。有现成计划时降级 standard 继续执行
      // (不浪费已有工作),没有计划时明确拒绝并给出 Basic 可用的替代路径。
      let effectiveMode = mode
      let proGateNote = ''
      if (mode === 'max' && !(options?.teamMaxEnabled ?? true)) {
        if (tasks || markdown) {
          effectiveMode = 'standard'
          proGateNote = '\n\n[Pro] team max（多视角规划）是 Pro 功能——已降级为 standard 模式执行现有计划。升级 Pro 解锁多视角 planner fanout。'
        } else {
          return {
            content: 'team_orchestrate: mode "max"（多视角规划 fanout）是 Pro 功能。Basic 替代路径：先用 plan_task 生成计划，再以 standard 模式执行；或升级 Pro 解锁。',
            isError: true,
          }
        }
      }

      // Standard mode needs a plan to execute; max mode generates one via planner
      // fanout, so only guard the standard path. A clear message beats the
      // "no dispatchable waves" weak result when nothing was provided/stored.
      if (effectiveMode === 'standard' && !tasks && !markdown) {
        return {
          content: 'team_orchestrate blocked: No plan provided and no stored plan found. Run plan_task first or pass planJson/planPath.',
          isError: true,
        }
      }

      // T9 P3 text stream + T4 structured per-worker updates (subagent panel).
      const textStreamer = params.onOutput ? createActivityStreamer(params.onOutput) : undefined
      const activityMapper = params.onWorkerActivity
        ? createDelegationActivityMapper(params.toolUseId, params.onWorkerActivity)
        : undefined
      const onActivity = (textStreamer || activityMapper)
        ? (ev: WorkerActivityEvent) => {
            textStreamer?.(ev)
            activityMapper?.(ev)
          }
        : undefined

      const effectiveFromWave = fromWave ?? 0

      let run: PlanExecutorRun
      try {
        run = await executePlan(
          {
            mode: effectiveMode,
            objective,
            tasks,
            planMarkdown: markdown,
            fromWave: effectiveFromWave,
            maxParallel: maxParallel ?? options?.defaultMaxParallel,
            sessionId: params.sessionId,
            parentTurnId: params.toolUseId,
            reviewDepth: params.reviewDepth ?? 0,
            cwd: params.cwd,
            abortSignal: params.abortSignal,
            // team_orchestrate IS the review-bearing path.
            reviewGate: true,
            // T9 P3: live worker token/tool stream into the team tool card.
            onActivity,
            // Fleet viz: emit the wave/task DAG (all waiting) before dispatch so
            // the TUI shows the plan up front; the engine overlays running state.
            onPlanReady: params.onOutput
              ? (skeleton, wave) => {
                  params.onOutput!(`\n${encodeTeamPanelModel(buildTeamPanelModel(skeleton, wave))}\n`)
                }
              : undefined,
            onProgress: params.onOutput
              ? (completed, total) => {
                  const done = Math.max(0, Math.min(completed, total))
                  params.onOutput!(`✦ team progress: ${done}/${total} workers done\n`)
                }
              : undefined,
          },
          coordinator,
        )
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return { content: `team_orchestrate failed: ${msg}`, isError: true }
      }

      const { summary, reviewVerdict, notes } = run

      // T4: terminal per-worker status for the subagent panel.
      if (params.onWorkerActivity && summary.run) {
        for (const r of summary.run.results) {
          params.onWorkerActivity({
            workOrderId: r.workOrderId,
            parentToolId: params.toolUseId,
            status: r.status,
            progressLine: r.summary.slice(0, 80),
            model: r.model,
            provider: r.provider,
            usage: r.usage,
            artifactId: r.diffArtifactId,
            changedFiles: r.changedFiles.length > 0 ? r.changedFiles : undefined,
          })
        }
      }

      const panelModel = buildTeamPanelModel(summary, effectiveFromWave, reviewVerdict)
      return {
        content: formatTeamSummary(summary, effectiveFromWave) + notes.reviewNote + notes.scopeHealthNote + notes.impactNote + notes.waveGateNote + notes.deliverySynthesis + planAdvisoryNote + proGateNote,
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
