import type { CompactCircuitBreakerState, CompactDecision, CompactTier } from './types.js'
import { adaptiveCompactPolicyRatios, compactPolicyRatios, precisionCeilingRatio } from '../compact/constants.js'
import type { ProviderProfile } from '../api/provider-profile.js'

export interface CompactPolicyInput {
  estimatedTokens: number
  maxTokens: number
  turn: number
  failures: CompactCircuitBreakerState
  providerProfile?: Pick<ProviderProfile, 'cacheType' | 'persistent'>
  /** Recent cache hit rate (0-1).  When ≥0.85, thresholds are shifted higher
   *  via adaptiveCompactPolicyRatios to delay compaction and protect the
   *  valuable prefix cache.  When null, falls back to base ratios. */
  recentHitRate?: number | null
  /** Optional explicit precision-ceiling override (0-1). When provided it
   *  replaces the window-derived default from {@link precisionCeilingRatio}.
   *  The ceiling forces compaction regardless of cache warmth once context
   *  usage reaches it, guarding model accuracy. */
  precisionCeilingOverride?: number
}

export function tierForRatio(
  ratio: number,
  providerProfile?: Pick<ProviderProfile, 'cacheType' | 'persistent'>,
  recentHitRate?: number | null,
  precisionCeiling?: number,
): CompactTier {
  const ratios = recentHitRate != null
    ? adaptiveCompactPolicyRatios(providerProfile, recentHitRate)
    : compactPolicyRatios(providerProfile)
  if (ratio >= ratios.ceiling) return 4
  if (ratio >= ratios.reactive) return 3
  if (ratio >= ratios.compact) return 2
  if (ratio >= ratios.watch) return 1
  // Precision ceiling: once context usage exceeds it, model-accuracy
  // degradation outweighs any cache savings, so force at least a compact tier
  // even if the cache-economic ratios (possibly nudged up by a hot cache) said
  // otherwise. This is the guard the cache-only strategy was missing.
  if (precisionCeiling !== undefined && ratio >= precisionCeiling) return 2
  return 0
}

function reasonForTier(tier: CompactTier): string {
  if (tier === 0) return 'context usage below watch threshold'
  if (tier === 1) return 'tool results exceeded watch threshold'
  if (tier === 2) return 'session memory compact recommended'
  if (tier === 3) return 'reactive round summarization required'
  return 'context ceiling exceeded; checkpoint-resume required'
}

export function decideCompactTier(input: CompactPolicyInput): CompactDecision {
  if (input.failures.disabledUntilTurn !== undefined && input.turn < input.failures.disabledUntilTurn) {
    return { tier: 0, reason: 'automatic compact circuit breaker is open', shouldCompact: false }
  }
  const ratio = input.maxTokens > 0 ? input.estimatedTokens / input.maxTokens : 1
  // Precision ceiling is derived from the window (larger windows hit accuracy
  // degradation sooner), or overridden by config. It forces compaction once
  // reached, even when a hot prefix cache would otherwise delay it.
  const precisionCeiling = precisionCeilingRatio(input.maxTokens, input.precisionCeilingOverride)
  const tier = tierForRatio(ratio, input.providerProfile, input.recentHitRate, precisionCeiling)
  return { tier, reason: reasonForTier(tier), shouldCompact: tier > 0 }
}

export function recordCompactFailure(state: CompactCircuitBreakerState, turn: number): CompactCircuitBreakerState {
  const consecutiveFailures = state.consecutiveFailures + 1
  return {
    consecutiveFailures,
    disabledUntilTurn: consecutiveFailures >= 3 ? turn + 3 : state.disabledUntilTurn,
  }
}

export function recordCompactSuccess(_state: CompactCircuitBreakerState): CompactCircuitBreakerState {
  return { consecutiveFailures: 0 }
}
