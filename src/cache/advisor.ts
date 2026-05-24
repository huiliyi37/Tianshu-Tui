import type { ProviderProfile } from '../api/provider-profile.js'
import type { CompactProviderStrategy } from '../compact/constants.js'
import { compactProviderStrategy } from '../compact/constants.js'
import type { TurnMetrics, CacheAdvisorDiagnostic } from './types.js'
import { GhostRegistry } from './ghost-registry.js'
import { CacheBehaviorLearner } from './behavior-learner.js'
import { AdaptiveThresholdController } from './adaptive-threshold.js'
import { SessionWarmthTracker } from './session-warmth.js'

export interface CacheAdvisorConfig {
  providerProfile: Pick<ProviderProfile, 'cacheType' | 'persistent'>
  ttlMs?: number
  now?: () => number
  /** Active context window — forwarded to AdaptiveThresholdController so
   *  its bounds scale with the window instead of capping at 4 000 chars. */
  contextWindow?: number
}

const PHASE_MULTIPLIERS: Record<string, number> = {
  explore: 1.0,
  plan: 1.5,
  execute: 1.0,
  verify: 2.0,
  deliver: 0.5,
}

export class CacheAdvisor {
  private readonly ghostRegistry: GhostRegistry
  private readonly behaviorLearner: CacheBehaviorLearner
  private readonly thresholdController: AdaptiveThresholdController
  private readonly warmthTracker: SessionWarmthTracker
  private readonly staticProfile: Pick<ProviderProfile, 'cacheType' | 'persistent'>
  private recentHitRate: number | null = null
  private currentTurn = 0

  constructor(config: CacheAdvisorConfig) {
    this.staticProfile = config.providerProfile
    this.ghostRegistry = new GhostRegistry()
    this.behaviorLearner = new CacheBehaviorLearner()
    this.thresholdController = new AdaptiveThresholdController({ ghostRegistry: this.ghostRegistry, contextWindow: config.contextWindow })
    this.warmthTracker = new SessionWarmthTracker({ ttlMs: config.ttlMs, now: config.now })
  }

  onTurnEnd(metrics: TurnMetrics): void {
    this.currentTurn = metrics.turn
    this.warmthTracker.recordApiCall()

    // Feed behavior learner
    this.behaviorLearner.observe({
      cacheRead: metrics.cacheRead,
      cacheCreation: metrics.cacheCreation,
      prefixChanged: metrics.prefixChanged,
    })

    // Record ghost evictions
    for (const id of metrics.artifactIdsEvicted) {
      this.ghostRegistry.record({
        artifactId: id,
        tool: '',
        target: '',
        evictedAtTurn: metrics.turn,
        originalTokens: 0,
      })
    }

    // Mark ghost accesses (read_section calls to previously-evicted artifacts)
    for (const id of metrics.artifactIdsAccessed) {
      this.ghostRegistry.markAccessed(id, metrics.turn)
    }

    // Compute recent hit rate
    const total = metrics.cacheRead + metrics.cacheCreation
    this.recentHitRate = total > 0 ? metrics.cacheRead / total : this.recentHitRate

    // Adjust thresholds based on feedback
    this.thresholdController.adjust(this.recentHitRate ?? 0.5, metrics.turn)
  }

  shouldDelayCompact(tier: number): boolean {
    // Never delay reactive (tier 3+) or ceiling (tier 4)
    if (tier >= 3) return false
    // Delay watch/compact tier when cache is healthy
    if (this.recentHitRate !== null && this.recentHitRate >= 0.8) return true
    // Delay when warmth is hot and tier is only watch
    if (this.warmthTracker.predict() === 'hot' && tier <= 1) return true
    return false
  }

  getArtifactThreshold(phase: string, isError: boolean): number {
    const state = this.thresholdController.getState()
    const base = isError ? state.artifactErrorThreshold : state.artifactThreshold
    const phaseMultiplier = PHASE_MULTIPLIERS[phase] ?? 1.0
    return Math.round(base * phaseMultiplier)
  }

  getStalePreviewChars(): number {
    return this.thresholdController.getState().stalePreviewChars
  }

  getCompactStrategy(): CompactProviderStrategy {
    const discovered = this.behaviorLearner.infer()
    if (this.staticProfile.cacheType === 'none' && discovered.hasCache && discovered.confidence > 0.6) {
      if (discovered.matchingStrategy === 'exact-prefix') return 'cache-preserving'
      return 'balanced'
    }
    return compactProviderStrategy(this.staticProfile)
  }

  getRecentHitRate(): number | null {
    return this.recentHitRate
  }

  shouldOpportunisticCompact(): boolean {
    return this.warmthTracker.shouldOpportunisticCompact()
  }

  getDiagnostic(): CacheAdvisorDiagnostic {
    return {
      temperature: this.warmthTracker.predict(),
      discoveredBehavior: this.behaviorLearner.infer(),
      ghostHitRate: 1 - this.ghostRegistry.getEvictionEfficiency(),
      currentThresholds: this.thresholdController.getState(),
      adaptiveStrategy: this.getCompactStrategy(),
      recentHitRate: this.recentHitRate,
    }
  }
}
