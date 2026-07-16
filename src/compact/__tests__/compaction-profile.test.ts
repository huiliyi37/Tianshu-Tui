import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  deriveCompactionProfile,
  windowBandFor,
  cacheKindFromProviderProfile,
  resolveCompactionEconomics,
  type CompactionProfile,
} from '../compaction-profile.js'

describe('windowBandFor', () => {
  it('classifies the three window bands stably', () => {
    assert.equal(windowBandFor(64_000), 'small')
    assert.equal(windowBandFor(128_000), 'small')
    assert.equal(windowBandFor(200_000), 'medium')
    assert.equal(windowBandFor(256_000), 'medium')
    assert.equal(windowBandFor(500_000), 'large')
    assert.equal(windowBandFor(1_000_000), 'large')
  })
})

describe('cacheKindFromProviderProfile', () => {
  it('maps persistent exact-prefix to exact-prefix', () => {
    assert.equal(cacheKindFromProviderProfile({ cacheType: 'exact-prefix', persistent: true }), 'exact-prefix')
  })
  it('maps non-persistent exact-prefix to partial (TTL-bound cache is not a paid persistent prefix)', () => {
    assert.equal(cacheKindFromProviderProfile({ cacheType: 'exact-prefix', persistent: false }), 'partial')
  })
  it('maps none to none and other cache types to partial', () => {
    assert.equal(cacheKindFromProviderProfile({ cacheType: 'none', persistent: false }), 'none')
    assert.equal(cacheKindFromProviderProfile({ cacheType: 'partial-prefix', persistent: false }), 'partial')
    assert.equal(cacheKindFromProviderProfile({ cacheType: 'explicit-breakpoint', persistent: false }), 'partial')
    assert.equal(cacheKindFromProviderProfile(undefined), 'none')
  })
})

describe('deriveCompactionProfile', () => {
  it('DeepSeek-style per-token + exact-prefix on 1M gets the high reclaim floor', () => {
    const p = deriveCompactionProfile({ contextWindow: 1_000_000, billing: 'per-token', cache: 'exact-prefix' })
    assert.equal(p.windowBand, 'large')
    assert.equal(p.minReclaimTokens, Math.max(32_768, Math.floor(1_000_000 * 0.05)))
    assert.equal(p.minReclaimTokens, 50_000)
    assert.equal(p.minReclaimRatio, 0.05)
    assert.equal(p.effectiveInputBudget, 1_000_000)
  })

  it('per-token + exact-prefix at 256k window: floor is max(8192, 3%) = 8192', () => {
    const p = deriveCompactionProfile({ contextWindow: 256_000, billing: 'per-token', cache: 'exact-prefix' })
    assert.equal(p.windowBand, 'medium')
    // floor(256000*0.03)=7680 < 8192 → 8192 (plan §3.2 self-check)
    assert.equal(p.minReclaimTokens, 8_192)
    assert.equal(p.minReclaimRatio, 0.03)
  })

  it('per-token + exact-prefix at 200k window keeps the small/medium floor', () => {
    const p = deriveCompactionProfile({ contextWindow: 200_000, billing: 'per-token', cache: 'exact-prefix' })
    assert.equal(p.minReclaimTokens, 8_192)
    assert.equal(p.minReclaimRatio, 0.03)
  })

  it('GLM/MiMo-style subscription gets the low floor even with exact-prefix cache', () => {
    const p = deriveCompactionProfile({ contextWindow: 1_000_000, billing: 'subscription', cache: 'exact-prefix' })
    assert.equal(p.minReclaimTokens, Math.max(4_096, Math.floor(1_000_000 * 0.01)))
    assert.equal(p.minReclaimTokens, 10_000)
    assert.equal(p.minReclaimRatio, 0.01)
  })

  it('Codex-style subscription + partial cache gets the low floor', () => {
    const p = deriveCompactionProfile({ contextWindow: 200_000, billing: 'subscription', cache: 'partial' })
    assert.equal(p.minReclaimTokens, 4_096)
    assert.equal(p.minReclaimRatio, 0.01)
  })

  it('per-token with NO cache also gets the low floor (no prefix worth protecting)', () => {
    const p = deriveCompactionProfile({ contextWindow: 256_000, billing: 'per-token', cache: 'none' })
    assert.equal(p.minReclaimTokens, 4_096)
    assert.equal(p.minReclaimRatio, 0.01)
  })

  it('carries billing/cache/prices through verbatim', () => {
    const p: CompactionProfile = deriveCompactionProfile({
      contextWindow: 1_000_000,
      billing: 'per-token',
      cache: 'exact-prefix',
      cacheReadPricePerMillion: 0.2,
      cacheWritePricePerMillion: 2,
    })
    assert.equal(p.billing, 'per-token')
    assert.equal(p.cache, 'exact-prefix')
    assert.equal(p.cacheReadPricePerMillion, 0.2)
    assert.equal(p.cacheWritePricePerMillion, 2)
  })

  it('is deterministic: same input → structurally identical output', () => {
    const a = deriveCompactionProfile({ contextWindow: 256_000, billing: 'per-token', cache: 'exact-prefix' })
    const b = deriveCompactionProfile({ contextWindow: 256_000, billing: 'per-token', cache: 'exact-prefix' })
    assert.deepEqual(a, b)
  })
})

describe('resolveCompactionEconomics (task 5: model-aware assembly adapter)', () => {
  it('DeepSeek V4 Pro on 1M: per-token + exact-prefix with the high floor', () => {
    const p = resolveCompactionEconomics({
      providerName: 'deepseek',
      modelId: 'deepseek-v4-pro',
      contextWindow: 1_000_000,
      baseUrl: 'https://api.deepseek.com',
      pricing: { cacheRead: 0.028, cacheWrite: 0.28 },
    })
    assert.equal(p.billing, 'per-token')
    assert.equal(p.cache, 'exact-prefix')
    assert.equal(p.minReclaimTokens, 50_000)
    assert.equal(p.cacheReadPricePerMillion, 0.028)
    assert.equal(p.cacheWritePricePerMillion, 0.28)
  })

  it('GLM coding plan: subscription + exact-prefix (lean floor despite the persistent cache)', () => {
    const p = resolveCompactionEconomics({
      providerName: 'glm',
      modelId: 'glm-5.2',
      contextWindow: 1_000_000,
      baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4',
    })
    assert.equal(p.billing, 'subscription')
    assert.equal(p.cache, 'exact-prefix')
    assert.equal(p.minReclaimTokens, 10_000)
  })

  it('MiMo coding plan vs mimo-api: subscription vs per-token from provider identity, not model alias', () => {
    const coding = resolveCompactionEconomics({
      providerName: 'mimo',
      modelId: 'mimo-v2.5',
      contextWindow: 1_000_000,
      baseUrl: 'https://token-plan-cn.xiaomimimo.com/v1',
    })
    assert.equal(coding.billing, 'subscription')
    assert.equal(coding.cache, 'exact-prefix')
    // Plan self-check: mimo-api must stay per-token — a model alias containing
    // "mimo" must never flip it to subscription.
    const api = resolveCompactionEconomics({
      providerName: 'mimo-api',
      modelId: 'mimo-v2.5',
      contextWindow: 1_000_000,
      baseUrl: 'https://api.xiaomimimo.com/v1',
    })
    assert.equal(api.billing, 'per-token')
    assert.equal(api.cache, 'exact-prefix')
    assert.equal(api.minReclaimTokens, 50_000)
  })

  it('Codex OAuth: subscription + partial cache (no persistent exact-prefix protection)', () => {
    const p = resolveCompactionEconomics({
      providerName: 'codex',
      modelId: 'gpt-5.2-codex',
      contextWindow: 200_000,
      authType: 'oauth',
      baseUrl: 'https://chatgpt.com/backend-api',
    })
    assert.equal(p.billing, 'subscription')
    assert.equal(p.cache, 'partial')
    assert.equal(p.minReclaimTokens, 4_096)
  })

  it('SiliconFlow: DeepSeek model gets exact-prefix via the deepseek-native capability + model family', () => {
    const p = resolveCompactionEconomics({
      providerName: 'siliconflow',
      modelId: 'deepseek-ai/DeepSeek-V4-Pro',
      contextWindow: 1_000_000,
      baseUrl: 'https://api.siliconflow.cn/v1',
      prefixCacheStrategy: 'deepseek-native',
    })
    assert.equal(p.billing, 'per-token')
    assert.equal(p.cache, 'exact-prefix')
    assert.equal(p.minReclaimTokens, 50_000)
  })

  it('SiliconFlow: a non-caching model family does NOT inherit exact-prefix protection', () => {
    const p = resolveCompactionEconomics({
      providerName: 'siliconflow',
      modelId: 'Qwen/Qwen3-Coder-Plus',
      contextWindow: 256_000,
      baseUrl: 'https://api.siliconflow.cn/v1',
      prefixCacheStrategy: 'deepseek-native',
    })
    assert.equal(p.billing, 'per-token')
    assert.notEqual(p.cache, 'exact-prefix')
  })

  it('unknown custom provider stays conservative per-token; pricing fields alone never imply per-token relaxation', () => {
    const p = resolveCompactionEconomics({
      providerName: 'my-custom-llm',
      modelId: 'whatever-2',
      contextWindow: 128_000,
      baseUrl: 'https://api.example.com/v1',
      pricing: { cacheRead: 0.1 },
    })
    assert.equal(p.billing, 'per-token')
    assert.equal(p.cache, 'none')
    // OAuth hint flips billing via classifyCostModel, not via pricing presence.
    const oauth = resolveCompactionEconomics({
      providerName: 'my-custom-llm',
      modelId: 'whatever-2',
      contextWindow: 128_000,
      authType: 'oauth',
      baseUrl: 'https://api.example.com/v1',
      pricing: { cacheRead: 0.1 },
    })
    assert.equal(oauth.billing, 'subscription')
  })
})
