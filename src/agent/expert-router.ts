/**
 * Expert Router — task → complementary star-domain expert set.
 *
 * Powers the dynamic planning council (team-orchestrator max mode): instead of
 * a hardcoded tianquan/tianfu/tianxuan trio, pick experts by keyword relevance
 * while guaranteeing perspective diversity (a base skeleton + a constraint gate
 * + a challenger, plus any matched domain specialist).
 *
 * Routing only — never selects a model tier. Council research profiles are
 * tierLock:'cheap' (Flash), so "flash routing is enough" holds by construction.
 */

import { starDomainRegistry } from './star-domain-registry.js'

/** Merge role — how an expert's contribution is adjudicated in mergePerspectivesByRole.
 *  - base: provides the task-graph skeleton (dependencies, execution order)
 *  - constraint: adds risk upgrades + verification gates (never downgrades)
 *  - challenger: alternatives, blind spots, anti-proof
 *  - specialist: domain-specific advisory (design, distillation…) — advisory/deferred */
export type ExpertRole = 'base' | 'constraint' | 'challenger' | 'specialist'

/** Built-in domain → merge role. Unknown / user domains default to 'specialist'. */
const DOMAIN_MERGE_ROLE: Record<string, ExpertRole> = {
  tianquan: 'base',
  tianshu: 'base',
  tianfu: 'constraint',
  tianliang: 'constraint',
  tianji: 'challenger',
  tianxuan: 'challenger',
  pojun: 'challenger',
  wenqu: 'specialist',
  fu: 'specialist',
}

/** Default council members when nothing matches strongly. Mirrors the historical
 *  hardcoded trio so behavior is preserved for generic tasks. */
const DEFAULT_BASE = 'tianquan'
const DEFAULT_CONSTRAINT = 'tianfu'
const DEFAULT_CHALLENGER = 'tianxuan'

/** Hard cap on council size — cost control (each member is one Flash worker). */
export const MAX_COUNCIL_EXPERTS = 5
/** Default council size when caller does not specify. */
export const DEFAULT_COUNCIL_EXPERTS = 3

export function mergeRoleFor(domainId: string): ExpertRole {
  return DOMAIN_MERGE_ROLE[domainId] ?? 'specialist'
}

export interface DomainScore {
  id: string
  score: number
  role: ExpertRole
}

/** Rank ALL domains by keyword hits against the task (descending).
 *  Unlike matchDomain (top-1, null on tie), this returns every domain that
 *  scored > 0 so the council can compose a diverse set. */
export function rankDomains(taskDescription: string): DomainScore[] {
  const lower = taskDescription.toLowerCase()
  const scored: DomainScore[] = []
  for (const domain of starDomainRegistry.list()) {
    let score = 0
    for (const keyword of domain.keywords) {
      if (lower.includes(keyword.toLowerCase())) score++
    }
    if (score > 0) scored.push({ id: domain.id, score, role: mergeRoleFor(domain.id) })
  }
  // Descending by score; stable tie-break by id for determinism.
  scored.sort((a, b) => (b.score - a.score) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  return scored
}

export interface SelectExpertOptions {
  /** Desired council size (clamped to [1, MAX_COUNCIL_EXPERTS]). Default 3. */
  maxExperts?: number
}

/**
 * Select a complementary set of star-domain experts for a planning council.
 *
 * Guarantees (within the size budget):
 *  1. Exactly one base (task-graph skeleton) — required for deterministic merge.
 *  2. One constraint (risk/verification gate) when a slot remains.
 *  3. One challenger (anti-proof / blind spots) when a slot remains.
 *  4. Any strongly-matched specialist (e.g. wenqu for design) when a slot remains.
 *  5. Remaining slots filled from the ranked list (dedup).
 *
 * The result's first element is always the base, so callers can rely on
 * `result[0]` being the merge skeleton.
 */
export function selectExpertSet(taskDescription: string, opts?: SelectExpertOptions): string[] {
  const budget = clampBudget(opts?.maxExperts)
  const ranked = rankDomains(taskDescription)
  const known = new Set(starDomainRegistry.getDomainIds())

  const pickTop = (role: ExpertRole): string | undefined =>
    ranked.find(d => d.role === role)?.id

  const selected: string[] = []
  const add = (id: string | undefined): void => {
    if (!id || selected.length >= budget) return
    if (!known.has(id)) return
    if (!selected.includes(id)) selected.push(id)
  }

  // 1. Base (skeleton) — highest-ranked base, else default. Always present.
  add(pickTop('base') ?? DEFAULT_BASE)

  // 2. Constraint gate.
  add(pickTop('constraint') ?? DEFAULT_CONSTRAINT)

  // 3. Challenger.
  add(pickTop('challenger') ?? DEFAULT_CHALLENGER)

  // 4. Matched specialist(s) — only if they actually scored (no default).
  for (const d of ranked) {
    if (d.role === 'specialist') add(d.id)
  }

  // 5. Fill remaining slots from the ranked list (relevance order).
  for (const d of ranked) add(d.id)

  // Final guard: never return empty (defensive — add() already seeds base).
  if (selected.length === 0) selected.push(DEFAULT_BASE)

  return selected.slice(0, budget)
}

function clampBudget(maxExperts?: number): number {
  const n = maxExperts ?? DEFAULT_COUNCIL_EXPERTS
  if (!Number.isFinite(n)) return DEFAULT_COUNCIL_EXPERTS
  return Math.max(1, Math.min(MAX_COUNCIL_EXPERTS, Math.floor(n)))
}
