import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { inferModelTierFromCard, recommendModelTier } from '../model-tier-policy.js'

describe('model tier policy', () => {
  it('routes verifier work to cheap (flash) for fast review throughput', () => {
    assert.equal(recommendModelTier({
      authority: 'tianliang',
      profile: 'verifier',
      kind: 'verify',
      objective: 'run tests and diagnose failures',
    }).tier, 'cheap')
  })

  it('allows low-risk tianliang patcher to be cheap but not high-risk patcher', () => {
    assert.equal(recommendModelTier({
      authority: 'tianliang',
      profile: 'patcher',
      kind: 'patch_proposal',
      riskTier: 'low',
      objective: 'small localized patch',
    }).tier, 'cheap')

    const highRisk = recommendModelTier({
      authority: 'tianliang',
      profile: 'patcher',
      kind: 'patch_proposal',
      riskTier: 'high',
      objective: 'security-sensitive persistence patch',
    })
    assert.equal(highRisk.tier, 'balanced')
    assert.equal(highRisk.hardFloor, 'balanced')
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
})
