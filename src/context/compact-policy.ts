import type { CompactCircuitBreakerState, CompactDecision, CompactTier } from './types.js'
import { adaptiveCompactPolicyRatios, compactPolicyRatios, precisionCeilingRatio } from '../compact/constants.js'
import type { ProviderProfile } from '../api/provider-profile.js'
import type { CompactionAction, CompactionProfile } from '../compact/compaction-profile.js'

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
  // Precision ceiling: once context usage exceeds it, model-accuracy
  // degradation outweighs any cache savings, so force at least a compact tier
  // even if the cache-economic ratios (possibly nudged up by a hot cache) said
  // otherwise. This is the guard the cache-only strategy was missing.
  //
  // It must be a floor, not a fallback branch. When the ceiling sits below the
  // watch threshold (cache-preserving: 0.70 vs 0.72), an earlier `return 1`
  // shadowed it and made the ladder non-monotonic — ratio 0.71 compacted while
  // 0.75 only watched.
  if (precisionCeiling !== undefined && ratio >= precisionCeiling) return 2
  if (ratio >= ratios.watch) return 1
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

/** 1M LLM-compaction ladder ratios — formerly literals buried inside
 *  CompactionController.maybeCompact's dedicated 1M branch. */
export const LLM_ACTION_RATIOS = { partial: 0.60, full: 0.75 } as const

/**
 * Ladder for per-token providers whose prefix cache is persistent and exact
 * (DeepSeek). An LLM rewrite invalidates a prefix the user already paid to
 * build, so the rung has to sit high enough that the reclaim is worth the
 * rebuild — the same cost asymmetry that made T9 quality compaction skip these
 * providers outright (3ffcf273).
 *
 * The base 0.60 rung shipped here from the token-explosion P1 fix (5482542,
 * 2026-06-11) and predates that reasoning. It was nominally guarded by
 * `cacheAdvisor.shouldDelayCompact`, but that guard cannot reach: its
 * `protection = hitRate × (1 − pressure) ≥ 0.45` test caps out at 0.55 pressure
 * even with a perfect hit rate, so a 99%-hit session still compacted at 0.60.
 */
export const CACHE_PRESERVING_LLM_ACTION_RATIOS = { partial: 0.75, full: 0.85 } as const

/**
 * Subscription providers keep the base ladder even when cache-preserving:
 * flat billing makes an early reclaim cost latency but no money, which is the
 * same split T9 encodes (`cachePreserving && !costInsensitive`).
 */
export function llmActionRatiosFor(profile: CompactionProfile): { partial: number; full: number } {
  return profile.billing === 'per-token' && profile.cache === 'exact-prefix'
    ? CACHE_PRESERVING_LLM_ACTION_RATIOS
    : LLM_ACTION_RATIOS
}

export interface CompactActionInput extends CompactPolicyInput {
  profile: CompactionProfile
}

export interface CompactActionDecision {
  action: CompactionAction
  reason: string
  /** Force actions (hard ceiling) bypass the reclaim gate AND advisor delay. */
  force: boolean
  /** Context usage crossed the model-accuracy precision ceiling. */
  precisionRisk: boolean
  /** Legacy tier, retained for observability and existing consumers. */
  tier: CompactTier
  shouldCompact: boolean
  profile: CompactionProfile
}

/**
 * Unified window-aware action decision (2026-07-16 reclaim gate plan task 4).
 *
 * Replaces the old split where 1M windows early-returned into a dedicated
 * 60%/75% branch that bypassed decideCompactTier — and with it the precision
 * ceiling. Windows now share one action vocabulary; the window only moves
 * thresholds:
 *
 *   - hard ceiling (0.95): force — 1M gets `checkpoint`, smaller windows get
 *     forced `micro` (their checkpoint owner remains enforceContextCeiling).
 *     Force wins over the circuit breaker: an over-window request is a hard
 *     API failure, not a tuning preference.
 *   - open breaker: no discretionary action.
 *   - 1M LLM ladder: provider-dependent, see {@link llmActionRatiosFor}.
 *     0.60/0.75 by default; 0.75/0.85 for per-token providers with a persistent
 *     exact prefix cache, where an LLM rewrite discards prefix bytes the user
 *     already paid for.
 *   - precision band: past the accuracy ceiling but below the LLM ladder —
 *     surfaces as a deterministic `stale-round` reclaim, which still has to
 *     clear the downstream reclaim gate and cache-advisor delay. Never a forced
 *     LLM rewrite (plan §1.4). On the default ladder this band is empty (the
 *     ceiling is 0.7 and partial-llm at 0.60 claims everything above it), but
 *     the cache-preserving ladder reopens it at 0.70–0.75: those providers now
 *     get the light deterministic reclaim in the band the LLM rung vacated.
 *   - everything else: the tier policy decides a deterministic `micro`.
 */
export function decideCompactAction(input: CompactActionInput): CompactActionDecision {
  const ratio = input.maxTokens > 0 ? input.estimatedTokens / input.maxTokens : 1
  const precisionCeiling = precisionCeilingRatio(input.maxTokens, input.precisionCeilingOverride)
  const precisionRisk = precisionCeiling < 1 && ratio >= precisionCeiling
  const tierDecision = decideCompactTier(input)
  const base = { precisionRisk, profile: input.profile }

  const ratios = input.recentHitRate != null
    ? adaptiveCompactPolicyRatios(input.providerProfile, input.recentHitRate)
    : compactPolicyRatios(input.providerProfile)
  if (ratio >= ratios.ceiling) {
    return input.maxTokens >= 1_000_000
      ? { ...base, action: 'checkpoint', reason: 'context ceiling exceeded; checkpoint-resume required', force: true, tier: 4, shouldCompact: true }
      : { ...base, action: 'micro', reason: 'context ceiling exceeded; forced deterministic reclaim', force: true, tier: 4, shouldCompact: true }
  }

  const breakerOpen = input.failures.disabledUntilTurn !== undefined && input.turn < input.failures.disabledUntilTurn
  if (breakerOpen) {
    return { ...base, action: 'none', reason: 'automatic compact circuit breaker is open', force: false, tier: 0, shouldCompact: false }
  }

  if (input.maxTokens >= 1_000_000) {
    const llmRatios = llmActionRatiosFor(input.profile)
    if (ratio >= llmRatios.full) {
      return { ...base, action: 'full-llm', reason: `full LLM compact ladder at ${(ratio * 100).toFixed(0)}%`, force: false, tier: tierDecision.tier, shouldCompact: true }
    }
    if (ratio >= llmRatios.partial) {
      return { ...base, action: 'partial-llm', reason: `partial LLM compact ladder at ${(ratio * 100).toFixed(0)}%`, force: false, tier: tierDecision.tier, shouldCompact: true }
    }
    if (precisionRisk) {
      return { ...base, action: 'stale-round', reason: 'precision-risk: past accuracy ceiling; deterministic reclaim only (gated)', force: false, tier: tierDecision.tier, shouldCompact: true }
    }
    return { ...base, action: 'none', reason: tierDecision.reason, force: false, tier: tierDecision.tier, shouldCompact: false }
  }

  if (tierDecision.shouldCompact) {
    return { ...base, action: 'micro', reason: tierDecision.reason, force: false, tier: tierDecision.tier, shouldCompact: true }
  }
  return { ...base, action: 'none', reason: tierDecision.reason, force: false, tier: tierDecision.tier, shouldCompact: false }
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
