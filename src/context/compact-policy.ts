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

/** 1M LLM-compaction ladder ratios — formerly literals buried inside
 *  CompactionController.maybeCompact's dedicated 1M branch. */
export const LLM_ACTION_RATIOS = { partial: 0.60, full: 0.75 } as const

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
 *   - 1M LLM ladder: full-llm ≥ 0.75, partial-llm ≥ 0.60 (unchanged ratios,
 *     now shared constants).
 *   - 1M precision band (≥ 0.5): no longer silently ignored — surfaces as a
 *     deterministic `stale-round` reclaim, which still has to clear the
 *     downstream reclaim gate and cache-advisor delay. Never a forced LLM
 *     rewrite (plan §1.4).
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
    if (ratio >= LLM_ACTION_RATIOS.full) {
      return { ...base, action: 'full-llm', reason: `full LLM compact ladder at ${(ratio * 100).toFixed(0)}%`, force: false, tier: tierDecision.tier, shouldCompact: true }
    }
    if (ratio >= LLM_ACTION_RATIOS.partial) {
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
