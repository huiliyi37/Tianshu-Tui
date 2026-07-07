import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { inferModelTierFromCard, inferModelTierFromName, recommendModelTier } from '../model-tier-policy.js'
import { applyTierFloor, escalationTierAllowed } from '../coordinator.js'

describe('model tier policy', () => {
  it('routes verifier work to cheap (flash) for fast review throughput', () => {
    assert.equal(recommendModelTier({
      authority: 'tianliang',
      profile: 'verifier',
      kind: 'verify',
      objective: 'run tests and diagnose failures',
    }).tier, 'cheap')
  })

  it('tianliang patcher defaults to cheap (flash) across all risk tiers', () => {
    // flash 能力足以承担各级风险的执行任务——不因 riskTier 预判降级。
    // 真撑不住时由 consecutiveFailures≥2 自动升 strong。
    for (const riskTier of ['low', 'medium', 'high'] as const) {
      assert.equal(recommendModelTier({
        authority: 'tianliang',
        profile: 'patcher',
        kind: 'patch_proposal',
        riskTier,
        objective: 'patch task',
      }).tier, 'cheap')
    }
  })

  it('workerTierOverride lets config set patcher to balanced or strong', () => {
    for (const tier of ['balanced', 'strong'] as const) {
      assert.equal(recommendModelTier({
        authority: 'tianliang',
        profile: 'patcher',
        kind: 'patch_proposal',
        riskTier: 'high',
        objective: 'patch task',
        workerTierOverride: tier,
      }).tier, tier)
    }
  })

  it('escalates repeated failures to strong', () => {
    const rec = recommendModelTier({
      profile: 'code_scout',
      kind: 'code_search',
      objective: 'read-only search after failed attempts',
      consecutiveFailures: 2,
    })
    assert.equal(rec.tier, 'strong')
    assert.equal(rec.hardFloor, 'strong')
  })

  it('infers actual model tier from capability cards', () => {
    assert.equal(inferModelTierFromCard({ model: 'cheap-flash', toolUseReliability: 0.6, jsonStability: 0.6, editSuccessRate: 0.6, testRepairRate: 0.6, contextWindow: 128_000 }), 'cheap')
    assert.equal(inferModelTierFromCard({ model: 'large-cache', toolUseReliability: 0.7, jsonStability: 0.7, editSuccessRate: 0.7, testRepairRate: 0.7, contextWindow: 1_000_000 }), 'strong')
  })

  it('defaults to cheap tier for unremarkable profiles', () => {
    assert.equal(recommendModelTier({
      profile: 'reviewer',
      kind: 'review',
      objective: 'review a simple change',
    }).tier, 'cheap')
  })

  it('reviewer tierLock overrides tianquan authority to cheap', () => {
    assert.equal(recommendModelTier({
      authority: 'tianquan',
      profile: 'reviewer',
      kind: 'review',
      objective: 'review false-green risk',
    }).tier, 'cheap')
  })

  it('patcher without risk tier defaults to cheap', () => {
    assert.equal(recommendModelTier({
      profile: 'patcher',
      kind: 'patch_proposal',
      objective: 'small localized patch',
    }).tier, 'cheap')
  })

  // ── 层1a: planner tier floor（重构事故链缺口 1）──
  it('planner profile has a balanced hard floor — flash must not author plans', () => {
    const rec = recommendModelTier({
      profile: 'planner',
      kind: 'code_search',
      objective: '为大重构出计划',
    })
    assert.equal(rec.tier, 'balanced')
    assert.equal(rec.hardFloor, 'balanced')
  })
})

describe('inferModelTierFromName (层1b 留痕推断)', () => {
  it('classifies common cheap/strong name shapes', () => {
    assert.equal(inferModelTierFromName('gemini-2.5-flash'), 'cheap')
    assert.equal(inferModelTierFromName('claude-haiku'), 'cheap')
    assert.equal(inferModelTierFromName('minimax-m2'), 'cheap')
    assert.equal(inferModelTierFromName('gemini-2.5-pro'), 'strong')
    assert.equal(inferModelTierFromName('claude-opus-4'), 'strong')
    assert.equal(inferModelTierFromName('gpt-5.5'), 'strong')
  })

  it('returns null for unrecognized names (no false provenance)', () => {
    assert.equal(inferModelTierFromName('deepseek-chat'), null)
    assert.equal(inferModelTierFromName('unknown-model'), null)
  })
})

describe('applyTierFloor (瑶光门接线)', () => {
  it('raises below-floor tiers and never lowers above-floor tiers', () => {
    assert.equal(applyTierFloor('cheap', 'balanced'), 'balanced')
    assert.equal(applyTierFloor('cheap', 'strong'), 'strong')
    assert.equal(applyTierFloor('strong', 'balanced'), 'strong', 'floor only lifts, never downgrades')
    assert.equal(applyTierFloor('balanced', 'balanced'), 'balanced')
  })

  it('is identity without a floor', () => {
    assert.equal(applyTierFloor('cheap', undefined), 'cheap')
  })
})

describe('failureEscalationCap (workers.escalationCap 失败升档天花板)', () => {
  it('off disables failure escalation — falls through to normal routing', () => {
    const rec = recommendModelTier({
      profile: 'code_scout',
      kind: 'code_search',
      objective: 'read-only search after failed attempts',
      consecutiveFailures: 2,
      failureEscalationCap: 'off',
    })
    assert.equal(rec.tier, 'cheap', 'escalation off: scout stays on cheap routing')
    assert.equal(rec.hardFloor, undefined)
  })

  it('balanced caps failure escalation below strong', () => {
    const rec = recommendModelTier({
      profile: 'code_scout',
      kind: 'code_search',
      objective: 'read-only search after failed attempts',
      consecutiveFailures: 2,
      failureEscalationCap: 'balanced',
    })
    assert.equal(rec.tier, 'balanced')
    assert.equal(rec.hardFloor, 'balanced')
  })

  it('strong (and absent cap) keeps the legacy escalate-to-strong behavior', () => {
    for (const cap of ['strong', undefined] as const) {
      const rec = recommendModelTier({
        profile: 'code_scout',
        kind: 'code_search',
        objective: 'read-only search after failed attempts',
        consecutiveFailures: 2,
        ...(cap ? { failureEscalationCap: cap } : {}),
      })
      assert.equal(rec.tier, 'strong')
      assert.equal(rec.hardFloor, 'strong')
    }
  })

  it('off does NOT touch upfront routing floors (planner keeps balanced floor)', () => {
    // escalationCap 只管失败升档——planner 的 balanced hardFloor（事故链层1a）
    // 与其他前置路由不受影响。
    const rec = recommendModelTier({
      profile: 'planner',
      kind: 'code_search',
      objective: '为大重构出计划',
      failureEscalationCap: 'off',
    })
    assert.equal(rec.tier, 'balanced')
    assert.equal(rec.hardFloor, 'balanced')
  })

  it('escalationTierAllowed maps cap to the max escalation tier', () => {
    assert.equal(escalationTierAllowed('off'), null)
    assert.equal(escalationTierAllowed('balanced'), 'balanced')
    assert.equal(escalationTierAllowed('strong'), 'strong')
    assert.equal(escalationTierAllowed(undefined), 'strong', 'library default stays legacy')
  })
})
