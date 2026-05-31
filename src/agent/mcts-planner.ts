import { ProjectionScorer } from './projection-scorer.js'

export interface PlanCandidate {
  text: string
  projectionScore: number
}

export interface MCTSPlanResult {
  /** Seeds that passed the junk filter (projection below threshold) */
  seeds: PlanCandidate[]
  /** All candidates including filtered ones */
  candidates: PlanCandidate[]
  /** True if all candidates were junk (pure echo of user wording) */
  allJunk: boolean
}

export interface MCTSPlannerOpts {
  /** Function that generates one candidate path given a prompt and branch index */
  explore: (prompt: string, branchIndex: number) => Promise<string>
  /** Number of parallel branches to explore (default: 3) */
  branches?: number
  /** Projection threshold — candidates above this are filtered as junk (default: 0.4) */
  threshold?: number
}

/**
 * MCTS-inspired planner — explores multiple candidate paths in parallel,
 * filters out junk (pure anchor echo), passes all surviving seeds to the
 * main model as inspiration.
 */
export class MCTSPlanner {
  private scorer = new ProjectionScorer()
  private exploreFn: MCTSPlannerOpts['explore']
  private branches: number
  private threshold: number

  constructor(opts: MCTSPlannerOpts) {
    this.exploreFn = opts.explore
    this.branches = opts.branches ?? 3
    this.threshold = opts.threshold ?? 0.4
  }

  /** Generate N candidate paths in parallel. */
  async expand(task: string): Promise<PlanCandidate[]> {
    const promises = Array.from({ length: this.branches }, (_, i) =>
      this.exploreFn(task, i).then(text => ({ text, projectionScore: 0 })),
    )
    return Promise.all(promises)
  }

  /** Score candidates by projection against anchor phrases. */
  score(candidates: PlanCandidate[], anchorPhrases: string[]): PlanCandidate[] {
    for (const c of candidates) {
      c.projectionScore = this.scorer.score(c.text, anchorPhrases)
    }
    return candidates
  }

  /** Filter: keep only seeds below projection threshold. */
  filter(candidates: PlanCandidate[]): PlanCandidate[] {
    return candidates.filter(c => c.projectionScore < this.threshold)
  }

  /** Full pipeline: expand → score → filter. */
  async plan(task: string, anchorPhrases: string[]): Promise<MCTSPlanResult> {
    const candidates = await this.expand(task)
    this.score(candidates, anchorPhrases)
    const seeds = this.filter(candidates)
    return { seeds, candidates, allJunk: seeds.length === 0 }
  }
}
