import { getProviderCacheDefaults, type ProviderProfile } from '../api/provider-profile.js'
import { classifyCostModel } from '../api/cost-model.js'

/**
 * Cost-aware compaction profile (2026-07-16 reclaim gate plan §3.1).
 *
 * Pure policy data — this module computes thresholds and action vocabulary
 * only. It never touches the session, never calls an API, and never reads
 * process state, so every decision built on it is unit-testable byte-for-byte.
 *
 * Two orthogonal economic axes drive the reclaim floors:
 *   - billing: per-token providers pay real money for a cache-miss re-prefill,
 *     so a rewrite must reclaim enough to beat the rebuild cost. Subscription
 *     providers only pay latency.
 *   - cache: exact-prefix persistent caches (DeepSeek/GLM/MiMo) are destroyed
 *     by any history rewrite; partial/none caches lose little.
 *
 * The floors deliberately do NOT depend on tier ratios — they answer a
 * different question ("is this candidate rewrite worth committing?") than the
 * tier policy ("should we attempt a compaction at all?").
 */

export type CompactionWindowBand = 'small' | 'medium' | 'large'
export type CompactionBilling = 'per-token' | 'subscription'
export type CompactionCache = 'none' | 'partial' | 'exact-prefix'
export type CompactionAction =
  | 'none'
  | 'stale-round'
  | 'micro'
  | 'partial-llm'
  | 'full-llm'
  | 'session-split'
  | 'checkpoint'

export interface CompactionProfile {
  windowBand: CompactionWindowBand
  contextWindow: number
  /**
   * Input budget the policy plans against. First version equals the labelled
   * context window — subtracting max_tokens would assume a provider-level
   * "input window = total − output reserve" contract that has not been
   * verified for our providers (plan §3.1). `outputReserveTokens` is the
   * explicit extension point once such a contract is confirmed per provider.
   */
  effectiveInputBudget: number
  outputReserveTokens?: number
  billing: CompactionBilling
  cache: CompactionCache
  cacheWritePricePerMillion?: number
  cacheReadPricePerMillion?: number
  /** Absolute floor: a non-force rewrite must reclaim at least this many tokens. */
  minReclaimTokens: number
  /** Relative floor: reclaimed / beforeTokens must reach this fraction. */
  minReclaimRatio: number
}

export interface CompactionDecision {
  action: CompactionAction
  reason: string
  force: boolean
  profile: CompactionProfile
}

export function windowBandFor(contextWindow: number): CompactionWindowBand {
  if (contextWindow >= 500_000) return 'large'
  if (contextWindow >= 200_000) return 'medium'
  return 'small'
}

/**
 * Collapse a ProviderProfile's cache axes into the compaction cache kind.
 * Only a persistent exact-prefix cache (DeepSeek/GLM/MiMo/LongCat) earns
 * exact-prefix protection; TTL-bound or breakpoint caches degrade to
 * 'partial' — worth something, but not worth skipping a good rewrite for.
 */
export function cacheKindFromProviderProfile(
  profile?: Pick<ProviderProfile, 'cacheType' | 'persistent'>,
): CompactionCache {
  if (!profile || profile.cacheType === 'none') return 'none'
  if (profile.cacheType === 'exact-prefix' && profile.persistent) return 'exact-prefix'
  return 'partial'
}

export interface CompactionProfileInput {
  contextWindow: number
  billing: CompactionBilling
  cache: CompactionCache
  cacheWritePricePerMillion?: number
  cacheReadPricePerMillion?: number
  outputReserveTokens?: number
}

/**
 * Reclaim floors (plan §3.2 first version):
 *
 * | profile                                   | minReclaimTokens                  | minReclaimRatio |
 * |-------------------------------------------|-----------------------------------|-----------------|
 * | small/medium + per-token + exact-prefix   | max(8192, floor(window×0.03))     | 0.03            |
 * | large + per-token + exact-prefix          | max(32768, floor(window×0.05))    | 0.05            |
 * | subscription OR cache none/partial        | max(4096, floor(window×0.01))     | 0.01            |
 */
export function deriveCompactionProfile(input: CompactionProfileInput): CompactionProfile {
  const windowBand = windowBandFor(input.contextWindow)
  const protectPaidPrefix = input.billing === 'per-token' && input.cache === 'exact-prefix'

  let minReclaimTokens: number
  let minReclaimRatio: number
  if (protectPaidPrefix && windowBand === 'large') {
    minReclaimTokens = Math.max(32_768, Math.floor(input.contextWindow * 0.05))
    minReclaimRatio = 0.05
  } else if (protectPaidPrefix) {
    minReclaimTokens = Math.max(8_192, Math.floor(input.contextWindow * 0.03))
    minReclaimRatio = 0.03
  } else {
    minReclaimTokens = Math.max(4_096, Math.floor(input.contextWindow * 0.01))
    minReclaimRatio = 0.01
  }

  return {
    windowBand,
    contextWindow: input.contextWindow,
    effectiveInputBudget: input.contextWindow,
    ...(input.outputReserveTokens !== undefined ? { outputReserveTokens: input.outputReserveTokens } : {}),
    billing: input.billing,
    cache: input.cache,
    ...(input.cacheWritePricePerMillion !== undefined ? { cacheWritePricePerMillion: input.cacheWritePricePerMillion } : {}),
    ...(input.cacheReadPricePerMillion !== undefined ? { cacheReadPricePerMillion: input.cacheReadPricePerMillion } : {}),
    minReclaimTokens,
    minReclaimRatio,
  }
}

export interface CompactionEconomicsInput {
  providerName?: string
  modelId?: string
  contextWindow: number
  /** Auth type from provider config ('oauth' implies subscription). */
  authType?: string
  /** Provider baseUrl — coding-plan / token-plan endpoints imply subscription. */
  baseUrl?: string
  /** Resolved capability strategy (config override already applied). */
  prefixCacheStrategy?: 'deepseek-native' | 'anthropic-cache-control' | 'none'
  /** Explicit cache profile — wins over the provider-name lookup when given. */
  providerProfile?: Pick<ProviderProfile, 'cacheType' | 'persistent'>
  /** Model pricing per 1M tokens (USD) from config, when known. */
  pricing?: { cacheRead?: number; cacheWrite?: number }
  outputReserveTokens?: number
}

/**
 * Model families with a verified persistent exact-prefix server cache. Used
 * only for the aggregator escape hatch below — a provider we know directly
 * (deepseek/glm/…) is classified via its ProviderProfile, not this list.
 */
const EXACT_PREFIX_MODEL_FAMILIES = ['deepseek', 'glm-', 'longcat']

function modelFamilyHasExactPrefixCache(modelId: string | undefined): boolean {
  const id = (modelId ?? '').toLowerCase()
  return EXACT_PREFIX_MODEL_FAMILIES.some(f => id.includes(f))
}

/**
 * Assembly-layer adapter (plan task 5): resolve a CompactionProfile from the
 * provider/model identity actually configured, instead of hardcoding economics
 * per call site.
 *
 * Billing comes from `classifyCostModel` — provider identity first, then
 * oauth/baseUrl hints. It is never inferred from the model alias: `mimo` (the
 * token-plan provider) is subscription while `mimo-api` serving the same model
 * stays per-token.
 *
 * Cache kind comes from the ProviderProfile for known providers. For
 * aggregators (SiliconFlow etc.) whose profile defaults to 'none' but whose
 * capabilities declare `deepseek-native` prefix caching, the model family
 * decides: a DeepSeek/GLM/LongCat model routed through the aggregator keeps
 * exact-prefix protection; an unverified family degrades to 'partial' so the
 * reclaim gate never over-protects a cache that may not exist.
 */
export function resolveCompactionEconomics(input: CompactionEconomicsInput): CompactionProfile {
  const billing = classifyCostModel(input.providerName, {
    ...(input.authType !== undefined ? { authType: input.authType } : {}),
    ...(input.baseUrl !== undefined ? { baseUrl: input.baseUrl } : {}),
  })

  const cacheSource = input.providerProfile ?? getProviderCacheDefaults(input.providerName ?? '')
  let cache = cacheKindFromProviderProfile(cacheSource)
  if (cache === 'none' && input.prefixCacheStrategy === 'deepseek-native') {
    cache = modelFamilyHasExactPrefixCache(input.modelId) ? 'exact-prefix' : 'partial'
  }

  return deriveCompactionProfile({
    contextWindow: input.contextWindow,
    billing,
    cache,
    ...(input.pricing?.cacheWrite !== undefined ? { cacheWritePricePerMillion: input.pricing.cacheWrite } : {}),
    ...(input.pricing?.cacheRead !== undefined ? { cacheReadPricePerMillion: input.pricing.cacheRead } : {}),
    ...(input.outputReserveTokens !== undefined ? { outputReserveTokens: input.outputReserveTokens } : {}),
  })
}
