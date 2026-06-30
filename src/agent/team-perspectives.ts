import { extractJsonCandidates, type WorkerResult } from './work-order.js'
import type { TeamTask, RiskItem } from './team-plan.js'
import { mergeRoleFor, type ExpertRole } from './expert-router.js'
import { starDomainRegistry } from './star-domain-registry.js'
import { validateTaskGraph, type TaskGraph } from './task-graph.js'

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
  /** Orthogonal shards from challenger/specialist that were folded into the
   *  executable `tasks` graph: gap-filled (disjoint) or monolith-split (cleanly
   *  partitioned a coarse base block). Distinct from `accepted` (advisory wins)
   *  because these change the dispatched task graph. */
  augmented: Array<{ source: string; title: string; reason: string }>
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
    return { tasks: [], dependencyNotes: [], risks: [], verification: [], accepted: [], rejected: [], deferred: [], augmented: [], conflicts: [] }
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
  const augmented: MergedPlan['augmented'] = []
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

    // Extra tasks are handled by the augment pass below (gap-fill / monolith-split
    // into the executable graph; only the leftovers fall back to deferred).

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

  // Step 6: augment — fold orthogonal shards from challenger/specialist into the
  // executable graph when base拆得过粗。Two levers, fail-safe to deferred otherwise:
  //   (B) monolith-split: a coarse base task (files≥2) cleanly partitioned by ≥2
  //       of one source's extras (parts pairwise-disjoint, each ⊆ base files) →
  //       replace the base block with the parts and reconnect dependents.
  //   (A) gap-fill: remaining extras with non-empty files disjoint from ALL current
  //       tasks → append (run in parallel). Overlap / no clean split → deferred
  //       (never silently written back, to avoid double-write/stomping).
  const existingIds = new Set(tasks.map(t => t.id))
  for (const src of [...challengers, ...specialists]) {
    const extras = src.tasks.filter(t => t.id && !existingIds.has(t.id) && !baseTaskIds.has(t.id))
    if (extras.length === 0) continue
    const consumed = new Set<TeamTask>()

    // (B) monolith-split over the current (possibly already-augmented) graph.
    for (const b of [...tasks]) {
      if (!existingIds.has(b.id)) continue
      const bFiles = filesOfTask(b)
      if (bFiles.length < 2) continue
      const bSet = new Set(bFiles)
      const parts = extras.filter(e => {
        if (consumed.has(e)) return false
        const ef = filesOfTask(e)
        return ef.length > 0 && ef.every(f => bSet.has(f))
      })
      if (parts.length < 2 || !pairwiseDisjoint(parts.map(filesOfTask))) continue
      const shards = parts.map(p => adoptShard(p, existingIds))
      for (const s of shards) {
        s.dependsOn = [...new Set([...s.dependsOn, ...b.dependsOn])].filter(d => d !== b.id && d !== s.id)
        existingIds.add(s.id)
      }
      const bi = tasks.findIndex(t => t.id === b.id)
      tasks.splice(bi, 1, ...shards)
      taskIndex.delete(b.id)
      existingIds.delete(b.id)
      for (const s of shards) taskIndex.set(s.id, s)
      const replacementIds = shards.map(s => s.id)
      for (const t of tasks) {
        if (t.dependsOn.includes(b.id)) {
          t.dependsOn = [...new Set([...t.dependsOn.filter(d => d !== b.id), ...replacementIds])]
        }
      }
      for (const p of parts) consumed.add(p)
      augmented.push({ source: src.perspective, title: `Monolith-split: ${b.id} → [${replacementIds.join(', ')}]`, reason: `${domainName(src.perspective)} cleanly partitioned a coarse base shard into parallel orthogonal shards` })
    }

    // (A) gap-fill remaining disjoint extras.
    for (const e of extras) {
      if (consumed.has(e)) continue
      const ef = filesOfTask(e)
      if (ef.length === 0) {
        deferred.push({ source: src.perspective, title: `Extra task: ${e.id}`, reason: 'No files declared; cannot verify orthogonality — deferred for manual review' })
        continue
      }
      if (tasks.every(t => fileSetsDisjoint(ef, filesOfTask(t)))) {
        const adopted = adoptShard(e, existingIds)
        tasks.push(adopted)
        taskIndex.set(adopted.id, adopted)
        existingIds.add(adopted.id)
        augmented.push({ source: src.perspective, title: `Gap-fill shard: ${adopted.id}`, reason: `${domainName(src.perspective)} orthogonal shard touches only disjoint files; folded into the execution graph for parallelism` })
      } else {
        deferred.push({ source: src.perspective, title: `Extra task: ${e.id}`, reason: 'Overlaps base files without a clean split; deferred to avoid double-write' })
      }
    }
  }

  // Step 7: validateTaskGraph fail-safe — strip dangling deps introduced by augment.
  const augmentedGraph: TaskGraph = {
    mission: base.summary,
    nodes: tasks.map(t => ({ id: t.id, title: t.title, objective: t.objective, profile: t.profile, kind: t.kind, files: t.files, dependsOn: t.dependsOn, riskTier: t.riskTier })),
    createdAt: 0,
  }
  if (!validateTaskGraph(augmentedGraph).valid) {
    const liveIds = new Set(tasks.map(t => t.id))
    for (const t of tasks) t.dependsOn = t.dependsOn.filter(d => liveIds.has(d))
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

  return { tasks, dependencyNotes, risks, verification, accepted, rejected, deferred, augmented, conflicts }
}

/** Effective file footprint of a task — prefer touchSet (write set) over the
 *  broader read/scope `files` when present. */
function filesOfTask(t: { files: string[]; touchSet?: string[] }): string[] {
  return t.touchSet && t.touchSet.length > 0 ? t.touchSet : (t.files ?? [])
}

/** True only when both sets are non-empty and share no file. Empty = unknown
 *  footprint → NOT provably disjoint (conservative → caller defers). */
function fileSetsDisjoint(a: string[], b: string[]): boolean {
  if (a.length === 0 || b.length === 0) return false
  const setB = new Set(b)
  return !a.some(f => setB.has(f))
}

/** All groups pairwise disjoint (used to confirm a clean monolith split). */
function pairwiseDisjoint(groups: string[][]): boolean {
  for (let i = 0; i < groups.length; i++) {
    for (let j = i + 1; j < groups.length; j++) {
      if (!fileSetsDisjoint(groups[i]!, groups[j]!)) return false
    }
  }
  return true
}

/** Normalize an adopted shard into a clean TeamTask with a unique id and safe
 *  defaults (planner output may omit fields at runtime despite the type). */
function adoptShard(raw: TeamTask, existingIds: Set<string>): TeamTask {
  const files = [...(raw.files ?? [])]
  const touchSet = raw.touchSet && raw.touchSet.length > 0 ? [...raw.touchSet] : [...files]
  const baseId = raw.id || 'shard'
  let id = baseId
  let suffix = 2
  while (existingIds.has(id)) id = `${baseId}__aug${suffix++}`
  return {
    id,
    title: raw.title ?? id,
    objective: raw.objective ?? '',
    files,
    profile: raw.profile ?? 'patcher',
    kind: raw.kind ?? 'patch_proposal',
    verification: [...(raw.verification ?? [])],
    dependsOn: [...(raw.dependsOn ?? [])],
    riskTier: raw.riskTier ?? 'medium',
    touchSet,
  }
}

/**
 * Fold the merged verification ledger back into each task's `verification`.
 *
 * `mergePerspectivesByRole` returns merged tasks (base graph) plus a separate
 * `verification` ledger that includes gates contributed by the constraint
 * perspective (天府). Without folding, those constraint-added acceptance gates
 * never reach the task — and therefore never reach the review focusHint that
 * reads `TeamTask.verification`. This attaches each taskId-tagged gate to its
 * task (deduped). Untagged gates (no taskId) are plan-level and left for the
 * caller to surface separately; they are not folded into every task to avoid
 * noise. Pure — returns new task objects, never mutates the input.
 */
export function foldVerificationIntoTasks(
  tasks: TeamTask[],
  verification: MergedPlan['verification'],
): TeamTask[] {
  if (verification.length === 0) return tasks
  const gatesByTask = new Map<string, string[]>()
  for (const gate of verification) {
    if (!gate.taskId) continue
    const command = gate.command.trim()
    if (!command) continue
    const arr = gatesByTask.get(gate.taskId) ?? []
    arr.push(command)
    gatesByTask.set(gate.taskId, arr)
  }
  if (gatesByTask.size === 0) return tasks
  return tasks.map(task => {
    const extra = gatesByTask.get(task.id)
    if (!extra || extra.length === 0) return task
    const merged = [...new Set([...task.verification, ...extra])]
    return { ...task, verification: merged }
  })
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
  base: '职责：把任务横向切成正交自包含分片，产出任务主图。每片是一个完整、独立的交付单元，由一个能力强的 flash 端到端独占（实现 + 自跑 tsc/lint/相关测试至全绿）。按模块/关注点边界切，分片间文件尽量两两不相交以便并行；只有真有先后依赖时才标 dependsOn。禁止按工序竖切（不要把 explore/patch/import/test/lint/type/verify 拆成独立角色任务）。宁可几个分量足的分片，不要一堆工序碎片。',
  constraint: '职责：聚焦跨分片的集成验证门禁与串行约束（每片已自验，你补的是分片之间的）。指出哪些分片因共享文件/接口必须串行并标 dependsOn；评估风险、回归测试；遇歧义 fail-closed。不要重新竖切别人的分片。',
  challenger: '职责：定向反证、盲区发现、质疑前提；并且——当 base 把某个分片拆得过粗（一个分片塞了多个本可并行的正交模块）时，提出更细的正交分片替代，每片标明 files（取自真实代码而非猜测），这些分片可被采纳进执行图。',
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
    '分片契约：每个 task 是一个横向正交、自包含的交付分片 —— 一个 flash 端到端做完（实现 + 自跑 tsc/lint/相关测试至全绿），profile 用 "patcher"、kind 用 "patch_proposal"。分片间 files 尽量两两不相交以便并行；两片必须改同一文件时用 dependsOn 排序，不要并发抢写。禁止按工序竖切成 explore/lint/type/import/test 等独立角色任务。files 填该分片真正会改的真实路径（来自代码查证，不要猜）。',
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
