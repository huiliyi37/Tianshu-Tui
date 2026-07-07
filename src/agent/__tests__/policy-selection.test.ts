import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { selectPolicy, renderPolicyGuidance, type PolicyOption } from '../policy-selection.js'
import type { EFEComponents } from '../prediction-error.js'
import type { AffordanceScore } from '../affordance.js'

const baseEFE: EFEComponents = {
  epistemicValue: 0.6,
  pragmaticValue: 0.4,
  noveltyBonus: 0.3,
  precision: 0.7,
}

const mockAffordances: Record<string, AffordanceScore> = {
  read_file:  { epistemic: 0.9, instrumental: 0.1, contextual: 0.8 },
  grep:       { epistemic: 0.85, instrumental: 0.15, contextual: 0.7 },
  glob:       { epistemic: 0.8, instrumental: 0.2, contextual: 0.6 },
  bash:       { epistemic: 0.2, instrumental: 0.8, contextual: 0.5 },
  write_file: { epistemic: 0.0, instrumental: 1.0, contextual: 0.4 },
  edit_file:  { epistemic: 0.1, instrumental: 0.9, contextual: 0.5 },
  run_tests:  { epistemic: 0.2, instrumental: 0.8, contextual: 0.4 },
}

describe('selectPolicy', () => {
  it('returns top-K results sorted by probability', () => {
    const result = selectPolicy(baseEFE, mockAffordances, { topK: 5 })
    assert.equal(result.length, 5)
    // Should be sorted descending by probability
    for (let i = 1; i < result.length; i++) {
      assert.ok(result[i - 1]!.probability >= result[i]!.probability,
        `position ${i}: ${result[i - 1]!.probability} should >= ${result[i]!.probability}`)
    }
  })

  it('all probabilities sum to ~1 for returned subset', () => {
    const result = selectPolicy(baseEFE, mockAffordances, { topK: 5 })
    const sum = result.reduce((s, p) => s + p.probability, 0)
    // Top-5 shouldn't sum to more than 1
    assert.ok(sum <= 1.01, `sum ${sum} should be <= 1`)
  })

  it('epistemic-heavy EFE favors epistemic tools', () => {
    const epistemicEFE: EFEComponents = {
      epistemicValue: 0.9, pragmaticValue: 0.1, noveltyBonus: 0.3, precision: 0.5,
    }
    const result = selectPolicy(epistemicEFE, mockAffordances, { topK: 3 })
    // Top tools should be epistemic-heavy
    const topNames = result.map(p => p.toolName)
    assert.ok(topNames.includes('read_file') || topNames.includes('grep') || topNames.includes('glob'),
      `top tools should include epistemic: ${topNames.join(', ')}`)
  })

  it('pragmatic-heavy EFE favors instrumental tools', () => {
    const pragmaticEFE: EFEComponents = {
      epistemicValue: 0.1, pragmaticValue: 0.9, noveltyBonus: 0.3, precision: 0.8,
    }
    const result = selectPolicy(pragmaticEFE, mockAffordances, { topK: 3 })
    const topNames = result.map(p => p.toolName)
    // write_file (instrumental=1.0) should be highly ranked
    const writeIdx = topNames.indexOf('write_file')
    const readIdx = topNames.indexOf('read_file')
    assert.ok(writeIdx >= 0, `write_file should be in top: ${topNames.join(', ')}`)
    if (readIdx >= 0) {
      assert.ok(writeIdx < readIdx, 'write_file should rank higher than read_file')
    }
  })

  it('low precision (high temperature) flattens distribution', () => {
    const lowPrec: EFEComponents = {
      epistemicValue: 0.7, pragmaticValue: 0.3, noveltyBonus: 0.3, precision: 0.3,
    }
    const highPrec: EFEComponents = {
      epistemicValue: 0.7, pragmaticValue: 0.3, noveltyBonus: 0.3, precision: 0.9,
    }
    // Asymmetric EFE + contrasting affordances → distinct G values
    const contrasting: Record<string, AffordanceScore> = {
      read_file:  { epistemic: 0.9, instrumental: 0.1, contextual: 0.8 },
      write_file: { epistemic: 0.0, instrumental: 1.0, contextual: 0.4 },
      bash:       { epistemic: 0.2, instrumental: 0.8, contextual: 0.5 },
    }
    const flat = selectPolicy(lowPrec, contrasting, { topK: 3 })
    const peaked = selectPolicy(highPrec, contrasting, { topK: 3 })
    const flatRange = flat[0]!.probability - flat[flat.length - 1]!.probability
    const peakedRange = peaked[0]!.probability - peaked[peaked.length - 1]!.probability
    assert.ok(flatRange < peakedRange,
      `flat range ${flatRange} should < peaked range ${peakedRange}`)
  })

  it('respects topK option', () => {
    assert.equal(selectPolicy(baseEFE, mockAffordances, { topK: 3 }).length, 3)
    assert.equal(selectPolicy(baseEFE, mockAffordances, { topK: 7 }).length, 7)
    assert.equal(selectPolicy(baseEFE, mockAffordances).length, 5) // default
  })

  it('handles empty affordances', () => {
    const result = selectPolicy(baseEFE, {}, { topK: 5 })
    assert.equal(result.length, 0)
  })

  it('custom temperature option overrides precision-based temperature', () => {
    // High temperature = flat distribution
    const hot = selectPolicy(baseEFE, mockAffordances, { temperature: 10, topK: 5 })
    const cold = selectPolicy(baseEFE, mockAffordances, { temperature: 0.1, topK: 5 })
    const hotRange = hot[0]!.probability - hot[4]!.probability
    const coldRange = cold[0]!.probability - cold[4]!.probability
    assert.ok(hotRange < coldRange, 'hot temperature should flatten')
  })
})

describe('renderPolicyGuidance', () => {
  it('returns empty for empty policies', () => {
    assert.equal(renderPolicyGuidance([], baseEFE), '')
  })

  it('renders XML block with EFE summary and ranking', () => {
    const policies = selectPolicy(baseEFE, mockAffordances, { topK: 3 })
    const result = renderPolicyGuidance(policies, baseEFE)
    assert.ok(result.startsWith('<policy-guidance>'))
    assert.ok(result.includes('EFE:'))
    assert.ok(result.includes('epistemic='))
    assert.ok(result.includes('pragmatic='))
    assert.ok(result.endsWith('</policy-guidance>'))
  })

  it('includes highest-probability action guidance when distribution is peaked', () => {
    // High precision + extreme EFE → peaked distribution → top tool > 0.3
    const peakedEFE: EFEComponents = {
      epistemicValue: 0.05, pragmaticValue: 0.95, noveltyBonus: 0.3, precision: 0.95,
    }
    // Use fewer tools so probability concentrates
    const fewTools: Record<string, AffordanceScore> = {
      read_file:  { epistemic: 0.9, instrumental: 0.1, contextual: 0.5 },
      write_file: { epistemic: 0.0, instrumental: 1.0, contextual: 0.5 },
    }
    const policies = selectPolicy(peakedEFE, fewTools, { topK: 2 })
    const result = renderPolicyGuidance(policies, peakedEFE)
    assert.ok(result.includes('Highest-probability action:'))
  })

  it('notes flat distribution when no action dominates', () => {
    const flatEFE: EFEComponents = {
      epistemicValue: 0.5, pragmaticValue: 0.5, noveltyBonus: 0.3, precision: 0.3,
    }
    const policies = selectPolicy(flatEFE, mockAffordances, { topK: 5 })
    const result = renderPolicyGuidance(policies, flatEFE)
    // If top probability is ≤ 0.3, use flat distribution message
    if (policies[0]!.probability <= 0.3) {
      assert.ok(result.includes('flat'))
    }
  })

  it('escapes XML special characters', () => {
    const policies: PolicyOption[] = [{
      toolName: '<script>alert("xss")</script>',
      expectedFreeEnergy: -0.5,
      probability: 0.9,
    }]
    const result = renderPolicyGuidance(policies, baseEFE)
    assert.ok(!result.includes('<script>'))
    assert.ok(result.includes('&lt;script&gt;'))
  })
})
