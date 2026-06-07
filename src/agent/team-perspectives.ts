import { extractJsonCandidates, type WorkerResult } from './work-order.js'
import type { TeamTask, RiskItem } from './team-plan.js'

// ── Perspective output schema ──────────────────────────────────────────────

export interface DependencyNote {
  from: string
  to: string
  reason: string
}

export interface PerspectiveRisk {
  taskId?: string
  severity: 'low' | 'medium' | 'high'
  claim: string
  mitigation: string
}

export interface PerspectiveVerification {
  taskId?: string
  command: string
  expected: string
}

export interface AlternativeProposal {
  title: string
  tradeoff: string
  recommendation: 'accept' | 'defer' | 'reject'
}

export interface TeamPerspectivePlan {
  perspective: 'tianquan' | 'tianfu' | 'tianxuan'
  summary: string
  tasks: TeamTask[]
  dependencyNotes: DependencyNote[]
  risks: PerspectiveRisk[]
  verification: PerspectiveVerification[]
  blockers: string[]
  alternatives: AlternativeProposal[]
}

// ── Merge result types ─────────────────────────────────────────────────────

export interface MergedPlan {
  tasks: TeamTask[]
  dependencyNotes: DependencyNote[]
  risks: RiskItem[]
  verification: Array<{ taskId?: string; command: string; expected: string }>
  accepted: Array<{ source: string; title: string; reason: string }>
  rejected: Array<{ source: string; title: string; reason: string }>
  deferred: Array<{ source: string; title: string; reason: string }>
  conflicts: Array<{ description: string; tianquan: string; tianfu: string; tianxuan?: string }>
}

// ── Perspective normalizer ─────────────────────────────────────────────────

/**
 * Normalize a raw worker output into a TeamPerspectivePlan.
 * Used when the model doesn't perfectly follow schema — graceful degradation.
 */
export function normalizePerspective(
  perspective: TeamPerspectivePlan['perspective'],
  raw: {
    summary?: string
    tasks?: TeamTask[]
    dependencyNotes?: DependencyNote[]
    risks?: PerspectiveRisk[]
    verification?: PerspectiveVerification[]
    blockers?: string[]
    alternatives?: AlternativeProposal[]
  },
): TeamPerspectivePlan {
  return {
    perspective,
    summary: raw.summary ?? `${perspective} perspective plan`,
    tasks: raw.tasks ?? [],
    dependencyNotes: raw.dependencyNotes ?? [],
    risks: raw.risks ?? [],
    verification: raw.verification ?? [],
    blockers: raw.blockers ?? [],
    alternatives: raw.alternatives ?? [],
  }
}

// ── Merge algorithm ────────────────────────────────────────────────────────

/**
 * Three-perspective deterministic merge:
 *
 * 1. 天权 (tianquan) = base plan (task graph, dependencies, execution order)
 * 2. 天府 (tianfu) = risk gate (adds verification gates, risk upgrades, serialization constraints)
 * 3. 天璇 (tianxuan) = challenger (alternatives, blind spots, anti-proof)
 *
 * Merging is NOT averaging — it's adjudication. 天权 provides the skeleton,
 * 天府 adds constraints, 天璇 provides alternatives that must earn acceptance.
 */
export function mergePerspectives(
  tianquan: TeamPerspectivePlan,
  tianfu: TeamPerspectivePlan,
  tianxuan?: TeamPerspectivePlan,
): MergedPlan {
  // Step 1: Deep-clone 天权 tasks as base graph (avoid polluting caller's objects)
  const tasks = tianquan.tasks.map(t => ({
    ...t,
    files: [...t.files],
    touchSet: [...t.touchSet],
    dependsOn: [...t.dependsOn],
    verification: [...t.verification],
  }))
  const taskIndex = new Map(tasks.map(t => [t.id, t]))

  const accepted: MergedPlan['accepted'] = []
  const rejected: MergedPlan['rejected'] = []
  const deferred: MergedPlan['deferred'] = []
  const conflicts: MergedPlan['conflicts'] = []

  // Step 2: Apply 天府 risk upgrades
  for (const risk of tianfu.risks) {
    if (risk.taskId && taskIndex.has(risk.taskId)) {
      const task = taskIndex.get(risk.taskId)!
      // Only upgrade risk, never downgrade
      if (riskSeverityRank(risk.severity) > riskSeverityRank(task.riskTier)) {
        task.riskTier = risk.severity
        accepted.push({
          source: 'tianfu',
          title: `Risk upgrade: ${risk.taskId} → ${risk.severity}`,
          reason: risk.claim,
        })
      }
    }
  }

  // Step 3: Apply 天府 verification gates
  const verification = [
    ...tianquan.verification.map(v => ({
      taskId: v.taskId,
      command: v.command,
      expected: v.expected,
    })),
    ...tianfu.verification
      .filter(v => !tianquan.verification.some(tv => tv.command === v.command))
      .map(v => {
        accepted.push({
          source: 'tianfu',
          title: `Verification: ${v.command}`,
          reason: `天府 added verification gate`,
        })
        return { taskId: v.taskId, command: v.command, expected: v.expected }
      }),
  ]

  // Step 4: Process 天璇 alternatives and detect conflicts
  if (tianxuan) {
    // Check for conflicts between perspectives
    const tianquanTaskIds = new Set(tianquan.tasks.map(t => t.id))
    const tianxuanExtraTasks = tianxuan.tasks.filter(t => !tianquanTaskIds.has(t.id))

    // Detect risk conflicts: 天府 and 天璇 disagree on severity.
    // Only correlate a risk to an alternative when the risk names a concrete
    // taskId — otherwise `''.includes` would match the first alternative and
    // fabricate a spurious "conflict on unknown".
    for (const tianfuRisk of tianfu.risks) {
      const riskTaskId = tianfuRisk.taskId?.toLowerCase()
      const tianxuanAlt = riskTaskId
        ? tianxuan.alternatives.find(a => a.title.toLowerCase().includes(riskTaskId))
        : undefined
      if (tianxuanAlt && tianxuanAlt.recommendation === 'accept') {
        // 天府 says risky, 天璇 says accept → conflict
        conflicts.push({
          description: `Risk vs alternative conflict on ${tianfuRisk.taskId ?? 'unknown'}`,
          tianquan: 'no position',
          tianfu: tianfuRisk.claim,
          tianxuan: tianxuanAlt.tradeoff,
        })
      }
    }

    // Detect task ordering conflicts: 天璇 proposes a different dependency SET
    // than 天权. Compare as sets (order-insensitive) so `[a,b]` vs `[b,a]` —
    // the same dependencies in a different order — is not a false conflict.
    for (const tianxuanTask of tianxuan.tasks) {
      const tianquanTask = tianquan.tasks.find(t => t.id === tianxuanTask.id)
      if (tianquanTask && !sameDependencySet(tianxuanTask.dependsOn, tianquanTask.dependsOn)) {
        const hasDepConflict = tianxuanTask.dependsOn.length > 0 || tianquanTask.dependsOn.length > 0
        if (hasDepConflict) {
          conflicts.push({
            description: `Dependency conflict on ${tianxuanTask.id}`,
            tianquan: `depends: [${tianquanTask.dependsOn.join(', ')}]`,
            tianfu: '(no position)',
            tianxuan: `depends: [${tianxuanTask.dependsOn.join(', ')}]`,
          })
        }
      }
    }

    for (const extraTask of tianxuanExtraTasks) {
      // Extra tasks from 天璇 are deferred unless explicitly smaller
      deferred.push({
        source: 'tianxuan',
        title: `Extra task: ${extraTask.id}`,
        reason: 'Not in 天权 base plan; deferred for manual review',
      })
    }

    // Process alternatives
    for (const alt of tianxuan.alternatives) {
      switch (alt.recommendation) {
        case 'accept':
          // 天璇 recommends acceptance — accept if it reduces scope
          accepted.push({
            source: 'tianxuan',
            title: alt.title,
            reason: alt.tradeoff,
          })
          break
        case 'defer':
          deferred.push({
            source: 'tianxuan',
            title: alt.title,
            reason: alt.tradeoff,
          })
          break
        case 'reject':
          rejected.push({
            source: 'tianxuan',
            title: alt.title,
            reason: alt.tradeoff,
          })
          break
      }
    }

    // Add 天璇 blind spots as risks
    for (const blocker of tianxuan.blockers) {
      accepted.push({
        source: 'tianxuan',
        title: `Blind spot: ${blocker.slice(0, 80)}`,
        reason: '天璇 identified potential blocker',
      })
    }
  }

  // Build merged risks
  const risks: RiskItem[] = [
    ...tianquan.risks.map(r => ({
      taskId: r.taskId,
      severity: r.severity,
      claim: r.claim,
      mitigation: r.mitigation,
    })),
    ...tianfu.risks
      .filter(r => !tianquan.risks.some(tr => tr.taskId === r.taskId && tr.claim === r.claim))
      .map(r => ({
        taskId: r.taskId,
        severity: r.severity,
        claim: `[天府] ${r.claim}`,
        mitigation: r.mitigation,
      })),
  ]

  // Merge dependency notes
  const dependencyNotes = [
    ...tianquan.dependencyNotes,
    ...tianfu.dependencyNotes.filter(d =>
      !tianquan.dependencyNotes.some(td => td.from === d.from && td.to === d.to)
    ),
  ]

  return {
    tasks,
    dependencyNotes,
    risks,
    verification,
    accepted,
    rejected,
    deferred,
    conflicts,
  }
}

function riskSeverityRank(severity: 'low' | 'medium' | 'high'): number {
  switch (severity) {
    case 'low': return 0
    case 'medium': return 1
    case 'high': return 2
  }
}

/** Order-insensitive comparison of two dependency lists. Treats them as sets,
 *  so `[a,b]` and `[b,a]` are equal (same dependencies, different declaration
 *  order — not a real ordering conflict). */
function sameDependencySet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false
  const setB = new Set(b)
  return a.every(dep => setB.has(dep))
}

// ── Planner fanout helpers (max mode) ───────────────────────────────────────

const PERSPECTIVE_BRIEFS: Record<TeamPerspectivePlan['perspective'], string> = {
  tianquan: '你是天权 planner。职责：依赖分析、任务拆解、执行顺序，产出任务主图。',
  tianfu: '你是天府 risk reviewer。职责：风险评估、验证门禁、回归测试、串行约束；遇歧义 fail-closed。',
  tianxuan: '你是天璇 challenger。职责：定向反证、盲区发现、备选方案；质疑前提。',
}

/** Build the objective for one perspective planner. The stance rides in the
 *  objective text; the worker is read-only and embeds its plan as an artifact. */
export function buildPlannerObjective(
  perspective: TeamPerspectivePlan['perspective'],
  mission: string,
): string {
  return [
    PERSPECTIVE_BRIEFS[perspective],
    '',
    `Mission: ${mission}`,
    '',
    'Read the relevant code, then return a JSON WorkerResult whose `artifacts` contains ONE entry:',
    '{ "kind": "note", "title": "perspective-plan", "content": "<a JSON string of your TeamPerspectivePlan>" }',
    '',
    'TeamPerspectivePlan = { perspective, summary, tasks, dependencyNotes, risks, verification, blockers, alternatives }.',
    'Each task = { id, title, objective, files, profile, kind, verification, dependsOn, riskTier, touchSet }.',
    `Set perspective to "${perspective}".`,
  ].join('\n')
}

/** Parse a planner WorkerResult back into a TeamPerspectivePlan. Reads the
 *  embedded `perspective-plan` artifact; falls back to a degraded plan that
 *  carries the worker summary + risks as blockers (graceful degradation). */
export function parsePerspectiveResult(
  perspective: TeamPerspectivePlan['perspective'],
  result: WorkerResult,
): TeamPerspectivePlan {
  const artifact = result.artifacts.find(a => a.title === 'perspective-plan')
  if (artifact) {
    try {
      for (const candidate of extractJsonCandidates(artifact.content)) {
        try {
          const raw = JSON.parse(candidate) as Parameters<typeof normalizePerspective>[1]
          return normalizePerspective(perspective, raw)
        } catch {
          // Try the next candidate — model output may include prose or malformed examples.
        }
      }
    } catch {
      // No JSON object found — fall through to degraded plan.
    }
  }
  return normalizePerspective(perspective, { summary: result.summary, blockers: result.risks })
}
