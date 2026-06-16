import { type ReasoningEffort } from './auto-reasoning.js'
import { type PredictionAccumulator, getErrorRate } from './prediction-error.js'
import { buildEffortContext, type EffortShadowRecord } from './p3-reward.js'
import { resolveEffortDelta } from './effort-delta.js'
import { type P3Integration } from './p3-integration.js'

/**
 * Dependencies for {@link ReasoningEffortController}. All access to AgentLoop
 * state goes through getter/setter closures so the controller never imports
 * AgentLoop (avoids a circular dependency). Wired in loop-factory.ts.
 */
export interface ReasoningEffortDeps {
  getReasoningFloor: () => string | undefined
  getConfigReasoningEffort: () => ReasoningEffort | undefined
  setConfigReasoningEffort: (effort: ReasoningEffort) => void
  setClientReasoningEffort: (effort: ReasoningEffort) => void
  isEffortBanditEnabled: () => boolean
  p3: P3Integration
  hasTaskContract: () => boolean
  getPredictionAccumulator: () => PredictionAccumulator
  getTurnCount: () => number
  getMaxTurns: () => number | undefined
  getFilesModifiedCount: () => number
  setCurrentEffortShadow: (record: EffortShadowRecord) => void
}

/**
 * Reasoning-effort cluster extracted verbatim from AgentLoop (W-L5b): the
 * rule + reasoningFloor + bandit-delta resolution and the T2-02 shadow
 * telemetry. Pure logic with no prefix-cache coupling.
 */
export class ReasoningEffortController {
  constructor(private readonly deps: ReasoningEffortDeps) {}

  set(effort: ReasoningEffort): void {
    const floor = this.deps.getReasoningFloor()
    const rank: Record<string, number> = { off: 0, low: 1, medium: 2, high: 3, max: 4 }
    const effective = (floor && (rank[effort] ?? 2) < (rank[floor] ?? 0)) ? floor as ReasoningEffort : effort
    // T2-02 Track A2: apply bandit delta (no-op when flag off or gate closed)
    const banditAdjusted = this.applyDelta(effective) as ReasoningEffort
    this.deps.setConfigReasoningEffort(banditAdjusted)
    this.deps.setClientReasoningEffort(banditAdjusted)
  }

  /**
   * T2-02 P0: Shadow telemetry for effort bandit.
   * Records recommendation without changing behavior.
   * Called at effort decision points (initial selection + intervention adjustments).
   *
   * @param ruleBaseline The effort the rule-based heuristic selected (e.g., 'medium')
   * @param overrides Partial context overrides from the caller
   */
  shadowTelemetry(
    ruleBaseline: string,
    overrides?: { errorRate?: number; isRepeat?: boolean },
  ): void {
    try {
      const ctx = buildEffortContext({
        taskComplexity: this.deps.hasTaskContract() ? 0.5 : 0.3,
        errorRate: overrides?.errorRate ?? getErrorRate(this.deps.getPredictionAccumulator()),
        turnDepth: this.deps.getTurnCount() / Math.max(this.deps.getMaxTurns() ?? 50, 1),
        fileCount: this.deps.getFilesModifiedCount(),
        isRepeat: overrides?.isRepeat ?? false,
        timeOfDay: new Date().getHours() / 24,
      })
      const record = this.deps.p3.shadowRecommendEffort(ctx, ruleBaseline)
      if (record) {
        this.deps.setCurrentEffortShadow(record)
      }
    } catch {
      // Shadow telemetry must never affect behavior
    }
  }

  /**
   * T2-02 P3: Get bandit-recommended effort delta.
   *
   * Returns null in three cases:
   * 1. Feature flag effortBanditEnabled is false (zero behavior change).
   * 2. Consistency gate not open (totalPulls < 30 or agreement rate < 0.8).
   * 3. Bandit itself declines the recommendation.
   *
   * Only when all three pass does the bandit get a vote.
   */
  getDelta(): number | null {
    if (!this.deps.isEffortBanditEnabled()) return null
    if (!this.deps.p3.isEffortGateOpen()) return null
    try {
      const ctx = buildEffortContext({
        taskComplexity: this.deps.hasTaskContract() ? 0.5 : 0.3,
        errorRate: getErrorRate(this.deps.getPredictionAccumulator()),
        turnDepth: this.deps.getTurnCount() / Math.max(this.deps.getMaxTurns() ?? 50, 1),
        fileCount: this.deps.getFilesModifiedCount(),
        isRepeat: false,
        timeOfDay: new Date().getHours() / 24,
      })
      const rec = this.deps.p3.recommendEffortDelta(ctx)
      return rec?.delta ?? null
    } catch {
      return null
    }
  }

  get(): ReasoningEffort | undefined {
    return this.deps.getConfigReasoningEffort()
  }

  applyDelta(baseEffort: string): string {
    try {
      const delta = this.getDelta()
      return resolveEffortDelta(baseEffort, delta, this.deps.getReasoningFloor())
    } catch {
      return baseEffort
    }
  }
}
