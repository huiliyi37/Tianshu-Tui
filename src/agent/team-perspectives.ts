import { extractJsonCandidates, type WorkerResult } from './work-order.js'
import type { TeamTask, RiskItem } from './team-plan.js'
import { mergeRoleFor, type ExpertRole } from './expert-router.js'
import { starDomainRegistry } from './star-domain-registry.js'

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
  /** Star-domain id of the planner (e.g. tianquan, tianfu, tianxuan, wenqu, or a
   *  user-defined domain). Its merge role is derived via mergeRoleFor(). */
  perspective: string
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

/** Resolve a perspective's display name (e.g. '天府') for human-readable merge notes. */
function domainName(perspective: string): string {
  return starDomainRegistry.get(perspective)?.name ?? perspective
}

/**
 * Role-based deterministic merge (the generalized council adjudicator):
 *
 *  - base       (天权…) provides the task-graph skeleton (deep-cloned).
 *  - constraint (天府/天梁…) upgrades risk tiers (never downgrades) + adds
 *    verification gates + contributes risks/dependency notes.
 *  - challenger (天机/天璇/破军…) raises conflicts, defers extra tasks, and
 *    classifies alternatives (accept/defer/reject) + blind spots.
 *  - specialist (文曲/辅…) contributes advisory-only proposals (always deferred)
 *    plus risks/dependency notes.
 *
 * Merging is adjudication, not averaging. Exactly one base supplies the graph;
 * everyone else earns acceptance. Backward compatible: with [base, constraint,
 * challenger] it reproduces the historical tianquan/tianfu/tianxuan merge.
 */
export function mergePerspectivesByRole(perspectives: TeamPerspectivePlan[]): MergedPlan {
  const base = perspectives.find(p => mergeRoleFor(p.perspective) === 'base') ?? perspectives[0]
  if (!base) {
    return { tasks: [], dependencyNotes: [], risks: [], verification: [], accepted: [], rejected: [], deferred: [], conflicts: [] }
  }
  const others = perspectives.filter(p => p !== base)
  const roleOf = (p: TeamPerspectivePlan): ExpertRole => mergeRoleFor(p.perspective)
  const constraints = others.filter(p => roleOf(p) === 'constraint')
  const challengers = others.filter(p => roleOf(p) === 'challenger')
  // Extra bases (defensive — selectExpertSet yields one) fold in as advisory specialists.
  const specialists = others.filter(p => roleOf(p) === 'specialist' || roleOf(p) === 'base')

  // Step 1: Deep-clone base tasks as the graph (avoid polluting caller's objects)
  const tasks = base.tasks.map(t => ({
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

  // Step 2+3: constraint risk upgrades + verification gates
  const verification = base.verification.map(v => ({ taskId: v.taskId, command: v.command, expected: v.expected }))
  for (const c of constraints) {
    for (const risk of c.risks) {
      if (risk.taskId && taskIndex.has(risk.taskId)) {
        const task = taskIndex.get(risk.taskId)!
        // Only upgrade risk, never downgrade
        if (riskSeverityRank(risk.severity) > riskSeverityRank(task.riskTier)) {
          task.riskTier = risk.severity
          accepted.push({ source: c.perspective, title: `Risk upgrade: ${risk.taskId} → ${risk.severity}`, reason: risk.claim })
        }
      }
    }
    for (const v of c.verification) {
      if (!verification.some(ev => ev.command === v.command)) {
        verification.push({ taskId: v.taskId, command: v.command, expected: v.expected })
        accepted.push({ source: c.perspective, title: `Verification: ${v.command}`, reason: `${domainName(c.perspective)} added verification gate` })
      }
    }
  }

  const baseTaskIds = new Set(base.tasks.map(t => t.id))

  // Step 4: challenger conflicts + alternatives + blind spots
  for (const ch of challengers) {
    // Risk-vs-alternative conflicts: a constraint flags risk, a challenger says accept.
    // Only correlate when the risk names a concrete taskId (avoid ''.includes match-all).
    for (const c of constraints) {
      for (const cRisk of c.risks) {
        const riskTaskId = cRisk.taskId?.toLowerCase()
        const alt = riskTaskId ? ch.alternatives.find(a => a.title.toLowerCase().includes(riskTaskId)) : undefined
        if (alt && alt.recommendation === 'accept') {
          conflicts.push({
            description: `Risk vs alternative conflict on ${cRisk.taskId ?? 'unknown'}`,
            tianquan: 'no position',
            tianfu: cRisk.claim,
            tianxuan: alt.tradeoff,
          })
        }
      }
    }

    // Dependency ordering conflicts: challenger proposes a different dependency SET.
    for (const chTask of ch.tasks) {
      const baseTask = base.tasks.find(t => t.id === chTask.id)
      if (baseTask && !sameDependencySet(chTask.dependsOn, baseTask.dependsOn)) {
        if (chTask.dependsOn.length > 0 || baseTask.dependsOn.length > 0) {
          conflicts.push({
            description: `Dependency conflict on ${chTask.id}`,
            tianquan: `depends: [${baseTask.dependsOn.join(', ')}]`,
            tianfu: '(no position)',
            tianxuan: `depends: [${chTask.dependsOn.join(', ')}]`,
          })
        }
      }
    }

    // Extra tasks from challengers are deferred for manual review.
    for (const extraTask of ch.tasks.filter(t => !baseTaskIds.has(t.id))) {
      deferred.push({ source: ch.perspective, title: `Extra task: ${extraTask.id}`, reason: `Not in ${domainName(base.perspective)} base plan; deferred for manual review` })
    }

    // Classify challenger alternatives.
    for (const alt of ch.alternatives) {
      const entry = { source: ch.perspective, title: alt.title, reason: alt.tradeoff }
      if (alt.recommendation === 'accept') accepted.push(entry)
      else if (alt.recommendation === 'defer') deferred.push(entry)
      else rejected.push(entry)
    }

    // Blind spots → accepted.
    for (const blocker of ch.blockers) {
      accepted.push({ source: ch.perspective, title: `Blind spot: ${blocker.slice(0, 80)}`, reason: `${domainName(ch.perspective)} identified potential blocker` })
    }
  }

  // Step 5: specialist advisory — domain proposals always defer (advisory by default).
  for (const sp of specialists) {
    for (const alt of sp.alternatives) {
      deferred.push({ source: sp.perspective, title: alt.title, reason: alt.tradeoff })
    }
    for (const blocker of sp.blockers) {
      deferred.push({ source: sp.perspective, title: `Advisory: ${blocker.slice(0, 80)}`, reason: `${domainName(sp.perspective)} domain note` })
    }
  }

  // Build merged risks: base + (constraints ∪ specialists) deduped & name-prefixed.
  // Challenger risks surface via conflicts/alternatives, not the risk ledger.
  const risks: RiskItem[] = base.risks.map(r => ({ taskId: r.taskId, severity: r.severity, claim: r.claim, mitigation: r.mitigation }))
  for (const p of [...constraints, ...specialists]) {
    for (const r of p.risks) {
      if (!risks.some(er => er.taskId === r.taskId && (er.claim === r.claim || er.claim === `[${domainName(p.perspective)}] ${r.claim}`))) {
        risks.push({ taskId: r.taskId, severity: r.severity, claim: `[${domainName(p.perspective)}] ${r.claim}`, mitigation: r.mitigation })
      }
    }
  }

  // Merge dependency notes from base + all others, deduped on from/to.
  const dependencyNotes = [...base.dependencyNotes]
  for (const p of others) {
    for (const d of p.dependencyNotes) {
      if (!dependencyNotes.some(td => td.from === d.from && td.to === d.to)) dependencyNotes.push(d)
    }
  }

  return { tasks, dependencyNotes, risks, verification, accepted, rejected, deferred, conflicts }
}

/**
 * Backward-compatible three-perspective merge. Delegates to the role-based
 * adjudicator with the historical 天权(base)/天府(constraint)/天璇(challenger) trio.
 */
export function mergePerspectives(
  tianquan: TeamPerspectivePlan,
  tianfu: TeamPerspectivePlan,
  tianxuan?: TeamPerspectivePlan,
): MergedPlan {
  return mergePerspectivesByRole(tianxuan ? [tianquan, tianfu, tianxuan] : [tianquan, tianfu])
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

/** Role → council responsibility line. The role (not the specific domain)
 *  defines what a planner must produce, so any domain can fill any seat. */
const ROLE_BRIEFS: Record<ExpertRole, string> = {
  base: '职责：依赖分析、任务拆解、执行顺序，产出任务主图。',
  constraint: '职责：风险评估、验证门禁、回归测试、串行约束；遇歧义 fail-closed。',
  challenger: '职责：定向反证、盲区发现、备选方案；质疑前提。',
  specialist: '职责：从你的专业领域视角给出建议与约束（默认进入 advisory）。',
}

/** Compose a one-line stance from the domain capsule (name + first line of its
 *  persona) so each planner reasons in-character; falls back to bare id. */
function perspectiveBrief(perspective: string): string {
  const role = mergeRoleFor(perspective)
  const domain = starDomainRegistry.get(perspective)
  const name = domain?.name ?? perspective
  const personaLine = domain?.volatileBlock.split('\n').map(l => l.trim()).find(l => l.length > 0)
  const head = `你是${name} planner。${ROLE_BRIEFS[role]}`
  return personaLine ? `${head}\n认知场：${personaLine}` : head
}

/** Build the objective for one perspective planner. The stance rides in the
 *  objective text; the worker is read-only and embeds its plan as an artifact. */
export function buildPlannerObjective(
  perspective: string,
  mission: string,
): string {
  return [
    perspectiveBrief(perspective),
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
