/**
 * Track 1: 统一 bandit shadow→gated 晋升闸。
 *
 * 契约：
 * - off  → 永不 enabled（kill switch）
 * - shadow → 永不 enabled
 * - forced → 永远 enabled（手动覆盖）
 * - auto → 样本量达标 + 无 false-green + scope 健康 + reward margin ≥ 阈值 → enabled
 * - effectiveBanditMode：killSwitch 压倒一切；legacy boolean=true 映射 forced
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { effectiveBanditMode, resolveBanditPromotion, DEFAULT_PROMOTION_THRESHOLDS } from '../bandit-promotion.js'
import type { GatedInfluenceEvaluationReport } from '../gated-influence-evaluation.js'
import { evaluateGatedInfluenceHistory } from '../gated-influence-evaluation.js'

function reportWith(overrides: Partial<GatedInfluenceEvaluationReport['sources']['model_tier_bandit']>): GatedInfluenceEvaluationReport {
  const base = evaluateGatedInfluenceHistory(null)
  return {
    ...base,
    sources: {
      ...base.sources,
      model_tier_bandit: { ...base.sources.model_tier_bandit, ...overrides },
    },
  }
}

describe('effectiveBanditMode', () => {
  it('killSwitch overrides everything', () => {
    assert.equal(effectiveBanditMode('forced', true, true), 'off')
    assert.equal(effectiveBanditMode('auto', true, true), 'off')
  })

  it('explicit mode wins over legacy boolean', () => {
    assert.equal(effectiveBanditMode('auto', true, false), 'auto')
    assert.equal(effectiveBanditMode('off', true, false), 'off')
  })

  it('legacy enabled=true maps to forced when mode is shadow default', () => {
    assert.equal(effectiveBanditMode('shadow', true, false), 'forced')
    assert.equal(effectiveBanditMode(undefined, true, false), 'forced')
  })

  it('defaults to shadow', () => {
    assert.equal(effectiveBanditMode(undefined, undefined, undefined), 'shadow')
    assert.equal(effectiveBanditMode('shadow', false, false), 'shadow')
  })
})

describe('resolveBanditPromotion', () => {
  it('off / shadow / forced are evidence-independent', () => {
    const strongEvidence = reportWith({ totalShadowSamples: 100, regretEstimate: 0.2 })
    assert.equal(resolveBanditPromotion({ source: 'model_tier_bandit', mode: 'off', report: strongEvidence }).enabled, false)
    assert.equal(resolveBanditPromotion({ source: 'model_tier_bandit', mode: 'shadow', report: strongEvidence }).enabled, false)
    assert.equal(resolveBanditPromotion({ source: 'model_tier_bandit', mode: 'forced' }).enabled, true)
  })

  it('auto: promotes when samples + margin thresholds are met', () => {
    const decision = resolveBanditPromotion({
      source: 'model_tier_bandit',
      mode: 'auto',
      report: reportWith({ totalShadowSamples: 50, regretEstimate: 0.12 }),
    })
    assert.equal(decision.enabled, true)
    assert.match(decision.reason, /promoted/)
    assert.equal(decision.evidence.totalShadowSamples, 50)
    assert.equal(decision.evidence.rewardMargin, 0.12)
  })

  it('auto: insufficient samples stays shadow', () => {
    const decision = resolveBanditPromotion({
      source: 'model_tier_bandit',
      mode: 'auto',
      report: reportWith({ totalShadowSamples: DEFAULT_PROMOTION_THRESHOLDS.minSamples - 1, regretEstimate: 0.5 }),
    })
    assert.equal(decision.enabled, false)
    assert.match(decision.reason, /samples/)
  })

  it('auto: false-green demotes regardless of margin', () => {
    const decision = resolveBanditPromotion({
      source: 'model_tier_bandit',
      mode: 'auto',
      report: reportWith({ totalShadowSamples: 100, regretEstimate: 0.5, falseGreenRate: 0.02 }),
    })
    assert.equal(decision.enabled, false)
    assert.match(decision.reason, /false-green/)
  })

  it('auto: scope-health veto blocks promotion', () => {
    const decision = resolveBanditPromotion({
      source: 'model_tier_bandit',
      mode: 'auto',
      report: reportWith({ totalShadowSamples: 100, regretEstimate: 0.5, worstScopeSeverity: 'high' }),
    })
    assert.equal(decision.enabled, false)
    assert.match(decision.reason, /scope-health/)
  })

  it('auto: missing or weak reward margin stays shadow', () => {
    const noMargin = resolveBanditPromotion({
      source: 'model_tier_bandit',
      mode: 'auto',
      report: reportWith({ totalShadowSamples: 100 }),
    })
    assert.equal(noMargin.enabled, false)
    assert.match(noMargin.reason, /margin/)

    const weakMargin = resolveBanditPromotion({
      source: 'model_tier_bandit',
      mode: 'auto',
      report: reportWith({ totalShadowSamples: 100, regretEstimate: 0.01 }),
    })
    assert.equal(weakMargin.enabled, false)
  })

  it('auto: no store at all degrades to shadow', () => {
    const decision = resolveBanditPromotion({ source: 'effort_bandit', mode: 'auto', store: null })
    assert.equal(decision.enabled, false)
  })

  it('custom thresholds are honored', () => {
    const decision = resolveBanditPromotion({
      source: 'model_tier_bandit',
      mode: 'auto',
      thresholds: { minSamples: 10, minRewardMargin: 0.01 },
      report: reportWith({ totalShadowSamples: 12, regretEstimate: 0.02 }),
    })
    assert.equal(decision.enabled, true)
  })
})
