import type { ProviderProfile } from '../api/provider-profile.js'
import type { CompactProviderStrategy } from '../compact/constants.js'
import { compactProviderStrategy } from '../compact/constants.js'
import type { TurnMetrics, CacheAdvisorDiagnostic } from './types.js'
import { GhostRegistry } from './ghost-registry.js'
import { CacheBehaviorLearner } from './behavior-learner.js'
import { AdaptiveThresholdController } from './adaptive-threshold.js'
import { SessionWarmthTracker } from './session-warmth.js'
import { RecallMetrics, type RecallMetricsSummary } from './recall-metrics.js'
import { isCompactHistoryId } from '../compact/recall-marker.js'

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
  private readonly recallMetrics: RecallMetrics
  private readonly staticProfile: Pick<ProviderProfile, 'cacheType' | 'persistent'>
  private recentHitRate: number | null = null
  private currentTurn = 0

  constructor(config: CacheAdvisorConfig) {
    this.staticProfile = config.providerProfile
    this.ghostRegistry = new GhostRegistry()
    this.recallMetrics = new RecallMetrics()
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
      // Recall observability: a read_section of a compact-history artifact is a
      // recall of archived storage-layer history. Observe-only — does not feed
      // back into compaction thresholds (see RecallMetrics rationale).
      if (isCompactHistoryId(id)) {
        this.recallMetrics.recordRecall(id, metrics.turn)
      }
    }

    // Compute recent hit rate
    const total = metrics.cacheRead + metrics.cacheCreation
    this.recentHitRate = total > 0 ? metrics.cacheRead / total : this.recentHitRate

    // Adjust thresholds based on feedback
    this.thresholdController.adjust(this.recentHitRate ?? 0.5, metrics.turn)
  }

  shouldDelayCompact(tier: number, ctx?: { estimatedTokens: number; contextWindow: number }): boolean {
    // Never delay reactive (tier 3+) or ceiling (tier 4)
    if (tier >= 3) return false

    // Track 4 显式权衡：cache miss 成本 vs 压缩收益。
    // 压缩后整段前缀作废 → miss 成本 ∝ hitRate（被缓存的输入占比）；
    // 压缩收益随窗口压力上升（接近阈值时余量价值高于缓存保护）。
    // protection = hitRate × (1 − pressure)：热缓存+低压力 → 延迟压缩；
    // 压力升高时即使缓存全热也放行（1M 下 OOM 风险 > 重建成本）。
    if (ctx && ctx.contextWindow > 0 && this.recentHitRate !== null) {
      const pressure = Math.min(1, Math.max(0, ctx.estimatedTokens / ctx.contextWindow))
      const protection = this.recentHitRate * (1 - pressure)
      if (protection >= 0.45) return true
      if (this.warmthTracker.predict() === 'hot' && tier <= 1 && pressure < 0.5) return true
      return false
    }

    // Legacy fallback (no pressure context provided)
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

  /** Register the turn at which a compact-history artifact was archived, so a
   *  later recall can be tagged with its turn distance. */
  registerArchive(artifactId: string, turn: number): void {
    this.recallMetrics.registerArchive(artifactId, turn)
  }

  /** Observe-only recall statistics for compacted-history artifacts. */
  getRecallSummary(): RecallMetricsSummary {
    return this.recallMetrics.getSummary()
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
      recall: this.recallMetrics.getSummary(),
    }
  }
}
