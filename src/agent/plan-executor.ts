/**
 * Shared plan execution kernel — the single closed loop behind both
 * `team_orchestrate` and `plan_task(execute:true)`.
 *
 * Wraps `runTeamSkeleton` (dispatch + wave grouping) with the full closed loop:
 *   - cross-wave failure propagation (session-scoped prior results)
 *   - scope-health (advisory leak/missing detection)
 *   - the review gate (force level + planned-gate focus + meridian blast radius
 *     + typecheck backstop), GATED by `reviewGate` so plan_task can skip it
 *     (plan_task's post-execution path is the commit flow, whose post-commit
 *     auto review gate already covers it — a pre-commit review here is redundant)
 *   - telemetry / scheduler-reward / episode reward closure + delivery synthesis
 *
 * The tool layer keeps its own I/O concerns (input parsing, size gate, panel
 * encoding, content/uiContent assembly); this kernel returns a structured result.
 */

import { isAbsolute } from 'node:path'
import type { CoordinatorRun, DelegationRequest } from './coordinator.js'
import { createCoordinatorReviewDeps } from './review-coordinator-deps.js'
import { classifyChangeScale, isCrossModule, isFixContext, type ChangeSet, type ReviewScale } from './review-discipline.js'
import { routeReviewWorkflow } from './review-router.js'
import { extractChangedFiles } from './diff-collector.js'
import { runTeamSkeleton, type TeamRunSummary } from './team-orchestrator.js'
import type { TeamTask } from './team-plan.js'
import { buildHistoricalTeamSchedulerState, type TeamSchedulerBanditState } from './team-scheduler-bandit.js'
import type { TeamSchedulerShadowEvent } from './team-scheduler-shadow.js'
import { persistGatedInfluenceAudit, type GatedInfluenceAuditEvent } from './gated-influence-audit.js'
import { buildTeamEpisodeFromStore, recordTeamEpisodeClosureFromStore } from './reward-loop.js'
import { formatTeamDelivery } from './team-episode.js'
import type { TeamWaveTelemetry } from './team-wave-telemetry.js'
import { buildTeamWaveScopeHealth, persistTeamScopeHealth } from './team-scope-health.js'
import type { AggregationPolicy } from './work-order.js'
import type { ImpactResult } from '../repo/meridian-impact.js'
import { runChangedFilesTypecheckMemo, typecheckGateEnabled, type TypecheckRunner } from './typecheck-gate.js'
import { getWaveResults, setWaveResults } from './wave-results-store.js'

/** Narrow surface for meridian structural impact analysis, so tests can mock it
 *  without the full MeridianIndexer. MeridianIndexer satisfies this structurally. */
export interface TeamImpactAnalyzer {
  impact(changedFiles: string[], opts?: { maxHops?: number }): ImpactResult
}

/** Coordinator + telemetry surface the shared executor needs. `delegateBatch`
 *  drives wave dispatch; `delegate` is required only when the review gate runs.
 *  All record/get hooks are optional so a lightly-wired caller still works. */
export interface PlanExecutorDeps {
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
  /** Optional injectable typecheck runner for the review-gate backstop. */
  getTypecheckRunner?: () => TypecheckRunner | undefined
}

export interface PlanExecutorOptions {
  mode: 'standard' | 'max'
  objective: string
  /** Pre-parsed tasks (UnifiedPlan path). */
  tasks?: TeamTask[]
  /** Markdown plan (team_orchestrate standard path). */
  planMarkdown?: string
  fromWave: number
  maxParallel?: number
  sessionId?: string
  parentTurnId?: string
  reviewDepth: number
  cwd: string
  abortSignal?: AbortSignal
  /** When false, the review-squadron dispatch is skipped. plan_task sets this
   *  false because its post-commit auto review gate covers it. */
  reviewGate: boolean
  onActivity?: DelegationRequest['onActivity']
  onPlanReady?: (summary: TeamRunSummary, fromWave: number) => void
  /** Per-wave progress passthrough (completed/total), for live tool output. */
  onProgress?: (completed: number, total: number) => void
}

export interface PlanExecutorRun {
  summary: TeamRunSummary
  reviewVerdict?: string
  notes: {
    reviewNote: string
    scopeHealthNote: string
    impactNote: string
    deliverySynthesis: string
  }
}

/** Join a list, truncating to `n` entries with a trailing elision count so a
 *  large blast radius doesn't flood the review focus / returned content. */
function capList(items: string[], n = 8): string {
  return items.length <= n ? items.join(', ') : `${items.slice(0, n).join(', ')} (+${items.length - n} more)`
}

function requireDelegate(deps: PlanExecutorDeps): Required<Pick<PlanExecutorDeps, 'delegate'>>['delegate'] {
  if (!deps.delegate) throw new Error('plan execution review gate requires deps.delegate')
  return deps.delegate
}

/**
 * Authoritative changed-file list for the review gate. Worker `changedFiles` is
 * model self-reported and can be empty even when real edits happened; the diff
 * artifact carries the real list, so we union diff-derived files with the self-report.
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
 *  - standard mode → raise the floor to ≥L2, upgrade to L3 on structural risk
 *    (cross-module / ≥3 tasks in the wave / any high-risk task).
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
 * Turn the merged plan's per-task verification gates into a reviewer focus hint.
 * Empty when no verification was planned.
 */
export function teamReviewFocusHint(waveTasks: TeamTask[]): string | undefined {
  const gates = [...new Set(waveTasks.flatMap(task => task.verification).map(v => v.trim()).filter(Boolean))]
  if (gates.length === 0) return undefined
  return `Planned acceptance gates (verify these, do not just trust green): ${gates.join('; ')}`
}

/**
 * Run a plan's wave-by-wave execution + closed loop. Throws on dispatch failure
 * (the tool layer wraps and reports). Returns the structured summary + notes the
 * tool stitches into its content/uiContent.
 */
export async function executePlan(opts: PlanExecutorOptions, deps: PlanExecutorDeps): Promise<PlanExecutorRun> {
  let telemetryEvent: TeamWaveTelemetry | undefined

  // Cross-wave failure propagation: pull the prior wave's results (Phase B —
  // session-scoped so the plan_task → team_orchestrate bridge survives).
  const priorResults = opts.fromWave > 0 ? getWaveResults(opts.sessionId) : undefined

  const summary = await runTeamSkeleton(
    {
      mode: opts.mode,
      objective: opts.objective,
      planMarkdown: opts.planMarkdown,
      tasks: opts.tasks,
      maxParallel: opts.maxParallel,
      fromWave: opts.fromWave,
      parentTurnId: opts.parentTurnId,
      abortSignal: opts.abortSignal,
      priorResults,
      teamSchedulerBanditEnabled: deps.isTeamSchedulerBanditEnabled?.() === true,
      onActivity: opts.onActivity,
      onPlanReady: opts.onPlanReady,
    },
    {
      delegateBatch: (requests, policy, abortSignal, onProgress) =>
        deps.delegateBatch(requests, policy, abortSignal, (completed, total) => {
          onProgress?.(completed, total)
          opts.onProgress?.(completed, total)
        }),
      recordTeamWaveTelemetry: event => {
        telemetryEvent = event
        deps.recordTeamWaveTelemetry?.(event)
      },
      recordTeamSchedulerShadow: event => deps.recordTeamSchedulerShadow?.(event),
      recordGatedInfluenceAudit: event => {
        if (deps.recordGatedInfluenceAudit) {
          deps.recordGatedInfluenceAudit(event)
          return
        }
        const store = deps.getTeamSchedulerRewardStore?.()
        if (store?.saveBanditState) persistGatedInfluenceAudit({ saveBanditState: store.saveBanditState.bind(store) }, event)
      },
      teamSchedulerState: deps.getTeamSchedulerState?.() ?? buildHistoricalTeamSchedulerState(deps.getTeamSchedulerRewardStore?.()),
      sessionId: deps.getSessionId?.(),
      // Track 2: 计划骨架缓存与 reward 共用同一 append-only 存储。
      planCacheStore: deps.getTeamSchedulerRewardStore?.(),
    },
  )

  // Cache this wave's results so the next wave (or the other tool) can propagate
  // failures forward.
  if (summary.run?.results) {
    setWaveResults(summary.run.results, opts.sessionId)
  }

  let reviewNote = ''
  let deliverySynthesis = ''
  let impactNote = ''
  let reviewVerdict: string | undefined
  const effectiveFromWave = opts.fromWave
  const isLastWave = summary.waves.length > 0 && effectiveFromWave >= summary.waves.length - 1

  // Scope-health (advisory): compare the real diff (telemetry's observedChangedFiles)
  // against planned.files to detect leak / missing coverage. Persist for learning,
  // surface medium/high, feed leaked files to the review focus. Never blocks.
  let scopeHealthNote = ''
  let scopeLeakedFiles: string[] = []
  if (telemetryEvent) {
    try {
      const health = buildTeamWaveScopeHealth(telemetryEvent)
      const rewardStore = deps.getTeamSchedulerRewardStore?.()
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

  // Review gate — gated by reviewGate (plan_task skips: post-commit auto review
  // covers it). reviewDepth guard prevents review workers from recursively
  // triggering another review pass.
  const changedFiles = teamReviewChangedFiles(summary.run)
  if (opts.reviewGate && isLastWave && changedFiles.length > 0 && opts.reviewDepth === 0) {
    try {
      const delegate = requireDelegate(deps)
      const taskById = new Map(summary.tasks.map(task => [task.id, task]))
      const waveTasks = (summary.waves[effectiveFromWave]?.taskIds ?? [])
        .map(id => taskById.get(id))
        .filter((task): task is TeamTask => Boolean(task))
      const change: ChangeSet = {
        files: changedFiles,
        crossModule: isCrossModule(changedFiles),
        isFix: isFixContext(opts.objective),
      }
      change.forceLevel = teamReviewForceLevel(opts.mode, change, waveTasks)
      const baseFocus = teamReviewFocusHint(waveTasks)
      // Advisory blast radius (meridian): downstream consumers + related tests for
      // the diff-derived observedChangedFiles. Never blocks; failures swallowed.
      let impactFocus: string | undefined
      try {
        const analyzer = deps.getMeridianIndexer?.()
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
      // Typecheck backstop — scoped tsc on the diff-derived changed files; a real
      // type error escalates the review to L3 and is surfaced FIRST. Advisory.
      let typecheckFocus: string | undefined
      const typecheckRunner = deps.getTypecheckRunner?.()
      if (typecheckGateEnabled() && typecheckRunner) {
        try {
          const observed = (telemetryEvent?.changedFiles.observedChangedFiles ?? []).filter(f => !isAbsolute(f))
          const tc = await runChangedFilesTypecheckMemo(opts.cwd, observed, typecheckRunner)
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
            deps.delegateBatch(requests, policy, abortSignal, onProgress),
        },
        { reviewDepth: opts.reviewDepth, abortSignal: opts.abortSignal, parentTurnId: `${opts.parentTurnId}:review` },
      )
      const outcome = await routeReviewWorkflow(change, reviewDeps, { maxRounds: 3, ...(focusHint ? { focusHint } : {}) })
      reviewVerdict = outcome.verdict
      reviewNote = `\n\nReview gate [${outcome.tier}]: ${outcome.verdict}${outcome.evidence ? ` — ${outcome.evidence}` : ''}`
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      throw new Error(`review gate failed: ${msg}`)
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
      deps.recordTeamWaveRewardClosure?.(closedTelemetry)
    } catch {
      // Reward closure must never affect team dispatch or review reporting.
    }
    try {
      deps.recordTeamSchedulerReward?.(closedTelemetry)
    } catch {
      // Scheduler reward must never affect team dispatch or review reporting.
    }
    if (isLastWave) {
      try {
        recordTeamEpisodeClosureFromStore(deps.getTeamSchedulerRewardStore?.(), closedTelemetry)
      } catch {
        // Episode closure must never affect team dispatch or review reporting.
      }
      try {
        const episode = buildTeamEpisodeFromStore(deps.getTeamSchedulerRewardStore?.(), closedTelemetry)
        deliverySynthesis = `\n\n${formatTeamDelivery(episode)}`
      } catch {
        // Delivery synthesis is presentation-only; never block the wave result.
      }
    }
  }

  return {
    summary,
    reviewVerdict,
    notes: { reviewNote, scopeHealthNote, impactNote, deliverySynthesis },
  }
}