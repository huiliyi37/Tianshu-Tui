/**
 * Review worker model override resolution.
 *
 * Pure functions that translate the `review.profiles` config block into a
 * concrete provider+model lookup for review worker dispatch.
 *
 * Why this exists: GLM/Kimi/Codex (prefixCache:'none') caches are evicted
 * when a concurrent review worker (running with the same primary model +
 * API key) issues requests against a different prompt. Routing the review
 * worker to a different provider+model decouples its cache footprint from
 * the session's primary prefix cache.
 */

import type { ProviderConfig } from '../config/schema.js'
import type { WorkerProfile } from './work-order.js'
import type { ModelCapabilityCard } from '../model/capability.js'

/** A resolved override: the provider config + model id to use for this profile. */
export interface ResolvedReviewOverride {
  providerName: string
  modelId: string
  providerConfig: ProviderConfig
}

/**
 * Resolve a review profile override against the configured providers.
 *
 * Returns undefined when:
 * - No override configured for this profile
 * - Configured provider does not exist in providers map
 * - Configured model does not exist in provider's models list
 *
 * @param profile The worker profile name (e.g. 'adversarial_verifier')
 * @param reviewProfiles The `review.profiles` record from config
 * @param providers The full providers map from config.provider.providers
 */
export function resolveReviewOverride(
  profile: WorkerProfile,
  reviewProfiles: Record<string, { provider: string; model: string }>,
  providers: Record<string, ProviderConfig>,
): ResolvedReviewOverride | undefined {
  const override = reviewProfiles[profile]
  if (!override) return undefined

  const providerConfig = providers[override.provider]
  if (!providerConfig) return undefined

  const modelExists = providerConfig.models.some(
    m => m.id === override.model || m.alias === override.model,
  )
  if (!modelExists) return undefined

  return {
    providerName: override.provider,
    modelId: override.model,
    providerConfig,
  }
}

/**
 * Build a ModelCapabilityCard for a review override model.
 *
 * 复用 bootstrap.ts:578-595 的 isPro/isFlash 检测，确保与现有 modelCards
 * 的 tier 推断（inferModelTierFromCard from model-tier-policy.ts）一致。
 * Review 是只读验证——不需要重型 capability scoring，给保守值即可。
 */
export function buildReviewOverrideCard(
  modelId: string,
  providerConfig: ProviderConfig,
): ModelCapabilityCard {
  const model = providerConfig.models.find(
    m => m.id === modelId || m.alias === modelId,
  )
  const contextWindow = model?.contextWindow ?? 128_000

  // 与 bootstrap.ts:578-585 完全一致的检测，避免 tier 漂移
  const isPro = modelId.includes('pro') || model?.alias?.includes('pro')
  const isFlash = modelId.includes('flash') || model?.alias?.includes('flash')
  const treatAsStrong = isPro || (!isFlash && !isPro)

  return {
    model: modelId,
    toolUseReliability: treatAsStrong ? 0.8 : 0.6,
    jsonStability: treatAsStrong ? 0.8 : 0.65,
    editSuccessRate: treatAsStrong ? 0.7 : 0.5,
    testRepairRate: treatAsStrong ? 0.6 : 0.45,
    contextWindow,
    cacheEconomics: 'strong' as const,
    recommendedTasks: ['code_search'],
  }
}
