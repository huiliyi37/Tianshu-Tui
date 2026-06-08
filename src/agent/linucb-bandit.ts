/**
 * P3-G: Online RL — Contextual Bandit (LinUCB)
 *
 * In-process contextual bandit that learns user preferences from
 * accept/reject signals. No GPU required. Constant-time updates.
 *
 * Arms = action choices (e.g., model, reasoning effort, tool strategy)
 * Context = feature vector from current task state
 * Reward: accept=+0.75, reject=-0.25, ignore=0
 *
 * Based on: LinUCB (Li et al. 2010), Cursor Tab RL pattern.
 */

export interface BanditArm {
  id: string
  /** Accumulated A matrix (d×d) stored as flat array */
  A: number[]
  /** Accumulated b vector (d×1) */
  b: number[]
  pulls: number
  totalReward: number
}

export interface BanditConfig {
  /** Feature dimension */
  dimension: number
  /** Exploration parameter (higher = more exploration) */
  alpha?: number
  /** Minimum probability threshold to suggest an action */
  minConfidence?: number
}

export interface BanditRecommendation {
  armId: string
  score: number
  confidence: number
}

const DEFAULT_ALPHA = 1.5
const DEFAULT_MIN_CONFIDENCE = 0.25

export class LinUCBBandit {
  private arms = new Map<string, BanditArm>()
  private readonly d: number
  private readonly alpha: number
  private readonly minConfidence: number
  private totalPulls = 0

  constructor(config: BanditConfig) {
    this.d = config.dimension
    this.alpha = config.alpha ?? DEFAULT_ALPHA
    this.minConfidence = config.minConfidence ?? DEFAULT_MIN_CONFIDENCE
  }

  /** Register an arm (action choice) */
  addArm(id: string): void {
    if (this.arms.has(id)) return
    // A = identity matrix (d×d), b = zero vector (d)
    const A = new Array(this.d * this.d).fill(0)
    for (let i = 0; i < this.d; i++) A[i * this.d + i] = 1
    const b = new Array(this.d).fill(0)
    this.arms.set(id, { id, A, b, pulls: 0, totalReward: 0 })
  }

  /** Select best arm given context features */
  recommend(context: number[]): BanditRecommendation | null {
    if (this.arms.size === 0) return null
    if (context.length !== this.d) return null

    let bestArm: string | null = null
    let bestScore = -Infinity

    for (const [id, arm] of this.arms) {
      const score = this.ucbScore(arm, context)
      if (score > bestScore) {
        bestScore = score
        bestArm = id
      }
    }

    if (!bestArm) return null
    const confidence = this.totalPulls > 0
      ? this.arms.get(bestArm)!.pulls / this.totalPulls
      : 0

    return { armId: bestArm, score: bestScore, confidence }
  }

  /** Should we suggest this action? (above min confidence threshold) */
  shouldSuggest(context: number[]): BanditRecommendation | null {
    const rec = this.recommend(context)
    if (!rec) return null
    // During cold start (< 10 pulls), always suggest to gather data
    if (this.totalPulls < 10) return rec
    return rec.score > this.minConfidence ? rec : null
  }

  /** Update arm with reward signal */
  update(armId: string, context: number[], reward: number): void {
    const arm = this.arms.get(armId)
    if (!arm || context.length !== this.d) return

    // A = A + x*x^T
    for (let i = 0; i < this.d; i++) {
      for (let j = 0; j < this.d; j++) {
        arm.A[i * this.d + j]! += context[i]! * context[j]!
      }
    }
    // b = b + reward * x
    for (let i = 0; i < this.d; i++) {
      arm.b[i]! += reward * context[i]!
    }

    arm.pulls++
    arm.totalReward += reward
    this.totalPulls++
  }

  /** Record accept signal (+0.75) */
  accept(armId: string, context: number[]): void {
    this.update(armId, context, 0.75)
  }

  /** Record reject signal (-0.25) */
  reject(armId: string, context: number[]): void {
    this.update(armId, context, -0.25)
  }

  /** Get arm statistics */
  getStats(): Array<{ id: string; pulls: number; avgReward: number }> {
    return [...this.arms.values()].map(a => ({
      id: a.id,
      pulls: a.pulls,
      avgReward: a.pulls > 0 ? a.totalReward / a.pulls : 0,
    }))
  }

  /** Serialize state for persistence */
  serialize(): string {
    return JSON.stringify({
      d: this.d,
      alpha: this.alpha,
      totalPulls: this.totalPulls,
      arms: [...this.arms.entries()],
    })
  }

  /** Restore from serialized state */
  static deserialize(json: string, config: BanditConfig): LinUCBBandit {
    const data = JSON.parse(json)
    const bandit = new LinUCBBandit(config)
    bandit.totalPulls = data.totalPulls ?? 0
    for (const [id, arm] of data.arms) {
      bandit.arms.set(id, arm)
    }
    return bandit
  }

  /**
   * In-place restore of arms + totalPulls from a serialized snapshot.
   *
   * Unlike `deserialize` (which builds a NEW instance), this overwrites the
   * live instance's state so a long-lived bandit reference can pick up
   * cross-session history. This is a REPLACE, not a merge: a freshly
   * constructed bandit has no learning worth preserving, so dropping its
   * cold-start arms in favor of the persisted ones is intentional.
   *
   * Throws on malformed JSON / shape; callers persisting non-critical state
   * should wrap in try/catch.
   */
  importState(json: string): void {
    const data = JSON.parse(json)
    this.arms = new Map<string, BanditArm>()
    for (const [id, arm] of data.arms) {
      this.arms.set(id, arm)
    }
    this.totalPulls = data.totalPulls ?? 0
  }

  private ucbScore(arm: BanditArm, x: number[]): number {
    // theta = A^{-1} * b (simplified: use diagonal approximation for speed)
    // Full matrix inverse is O(d^3), diagonal approx is O(d)
    const theta = new Array(this.d).fill(0)
    for (let i = 0; i < this.d; i++) {
      const aii = arm.A[i * this.d + i]!
      theta[i] = aii > 0 ? arm.b[i]! / aii : 0
    }

    // p = theta^T * x + alpha * sqrt(x^T * A^{-1} * x)
    let exploit = 0
    let explore = 0
    for (let i = 0; i < this.d; i++) {
      exploit += theta[i]! * x[i]!
      const aii = arm.A[i * this.d + i]!
      explore += aii > 0 ? (x[i]! * x[i]!) / aii : 0
    }

    return exploit + this.alpha * Math.sqrt(explore)
  }
}
