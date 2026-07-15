import { buildModelRoutingShadowEvent, inferLegacyRoutingRecommendation, persistModelRoutingShadow } from './model-routing-shadow.js'
import { buildModelPolicyCandidates, selectModelPolicy } from './model-policy-selection.js'
import { buildHistoricalModelRewards } from './model-reward-summary.js'
import { recordRoutingRewardClosure } from './reward-loop.js'
import { type Sensorium } from './sensorium.js'
import { type EFEComponents } from './prediction-error.js'
import { type TrajectoryEntry } from './trajectory.js'
import { type ModelCapabilityCard } from '../model/capability.js'
import { type MeridianDb } from '../repo/meridian-db.js'

/**
 * Dependencies for {@link ModelRoutingShadowController}. All AgentLoop access
 * goes through closures so the controller never imports AgentLoop. Wired in
 * loop-factory.ts.
 */
export interface ModelRoutingShadowDeps {
  getShadowEnabled: () => boolean | undefined
  getDb: () => MeridianDb | undefined
  getTrajectoryEntries: () => TrajectoryEntry[]
  getModelCards: () => ModelCapabilityCard[] | undefined
  getSessionId: () => string | undefined
  getTurnCount: () => number
  getInitialUserMessage: () => string | null | undefined
  getCurrentModel: () => string | undefined
  hasCurrentModelOverride: () => boolean
  getFallbackModel: () => string
  /** W4-D2: latest main-loop verification status (EvidenceTracker), if any. */
  getLatestVerificationOutcome?: () => 'passed' | 'failed' | 'blocked' | undefined
}

/**
 * Model-routing shadow telemetry extracted verbatim from AgentLoop (W-L6b).
 * Records the EFE-vs-legacy routing recommendation as a shadow event that never
 * affects the turn. No prefix-cache coupling.
 */
export class ModelRoutingShadowController {
  constructor(private readonly deps: ModelRoutingShadowDeps) {}

  record(currentSensorium: Sensorium, efe: EFEComponents): void {
    if (this.deps.getShadowEnabled() === false) return
    const store = this.deps.getDb()
    if (!store) return

    try {
      const recentCalls = this.deps.getTrajectoryEntries().slice(-10).map(entry => ({
        name: entry.tool,
        isError: entry.status === 'failed' || entry.status === 'retried-failed',
      }))
      const modelCards = this.deps.getModelCards()
      const legacyRouting = inferLegacyRoutingRecommendation(recentCalls, modelCards)
      const historicalRewards = buildHistoricalModelRewards(store)
      const efeRecommendation = selectModelPolicy({
        candidates: buildModelPolicyCandidates(modelCards, { historicalRewards }),
        efe,
        sensorium: currentSensorium,
        topK: 1,
      })[0]
      const event = buildModelRoutingShadowEvent({
        sessionId: this.deps.getSessionId() ?? 'unknown',
        turn: this.deps.getTurnCount(),
        objective: this.deps.getInitialUserMessage() ?? '',
        currentModel: this.deps.getCurrentModel() ?? this.deps.getFallbackModel(),
        selectedBy: this.deps.hasCurrentModelOverride() ? 'human' : 'config',
        legacyRouting,
        ...(efeRecommendation ? { efeRecommendedModel: efeRecommendation.model } : {}),
        ...(() => {
          const outcome = this.deps.getLatestVerificationOutcome?.()
          return outcome ? { verificationOutcome: outcome } : {}
        })(),
        sensorium: currentSensorium,
      })
      persistModelRoutingShadow(store, event)
      recordRoutingRewardClosure(store, event)
    } catch {
      // Shadow telemetry must never affect the turn.
    }
  }
}
