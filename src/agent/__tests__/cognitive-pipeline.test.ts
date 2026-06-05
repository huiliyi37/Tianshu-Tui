import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  computeAffordanceScores,
  renderAffordanceHint,
  adaptAffordanceFromHistory,
  toolAffordanceRegistry,
  type AffordanceState,
} from '../affordance.js'
import { computeEFE, createPredictionAccumulator, recordPrediction } from '../prediction-error.js'
import { selectPolicy, renderPolicyGuidance, type PolicyOption } from '../policy-selection.js'
import type { Sensorium } from '../sensorium.js'
import type { VigorState } from '../vigor.js'
import type { CognitiveSeason } from '../cognitive-season.js'
import type { ThetaPhase } from '../star-event.js'
import type { EFEComponents } from '../prediction-error.js'
import type { AffordanceScore } from '../affordance.js'

// ─── Mock helpers ──────────────────────────────────────────────────

function mockSensorium(overrides?: Partial<Sensorium>): Sensorium {
  return {
    momentum: 0.5,
    pressure: 0.3,
    confidence: 0.5,
    complexity: 0.4,
    freshness: 0.6,
    stability: 0.7,
    ...overrides,
  }
}

function mockVigor(overrides?: Partial<VigorState>): VigorState {
  return {
    tonic: 0.6,
    phasic: 0.1,
    curiosity: 0.4,
    vigor: 0.7,
    variability: 0.1,
    history: [],
    ...overrides,
  }
}

function mockAffordanceState(overrides?: Partial<AffordanceState>): AffordanceState {
  return {
    sensorium: null,
    vigor: null,
    thetaPhase: null,
    season: null,
    workingSetSize: 0,
    recentToolNames: [],
    ...overrides,
  }
}

/**
 * Build a PredictionAccumulator with a specific sequence of outcomes.
 * true = correct prediction, false = error.
 */
function mockAccumulator(predictions: boolean[]) {
  let acc = createPredictionAccumulator(10)
  for (const p of predictions) {
    acc = recordPrediction(acc, p)
  }
  return acc
}

// ─── Integration Tests ────────────────────────────────────────────

describe('Cognitive Pipeline — end-to-end', () => {
  it('generates affordance hint with epistemic preference after early exploration', () => {
    // Simulate: 1 successful tool execution, low confidence → high uncertainty
    const state: AffordanceState = {
      sensorium: mockSensorium({ confidence: 0.2, freshness: 0.3 }),
      vigor: null,
      thetaPhase: 'encoding',
      season: 'genesis',
      workingSetSize: 2,
      recentToolNames: ['read_file'],
    }

    // 1. computeEFE → should favor epistemic (due to low confidence)
    const acc = mockAccumulator([true])
    const efe = computeEFE(acc, state.season, state.vigor, state.sensorium)
    assert.ok(efe.epistemicValue > efe.pragmaticValue,
      `epistemic ${efe.epistemicValue} should > pragmatic ${efe.pragmaticValue} in early exploration`)

    // 2. computeAffordanceScores → epistemic tools should score high
    const scores = computeAffordanceScores(state)
    const readFileScore = scores['read_file']!
    const writeFileScore = scores['write_file']!
    assert.ok(readFileScore.epistemic > writeFileScore.epistemic,
      'read_file epistemic should > write_file epistemic')
    assert.ok(readFileScore.epistemic > readFileScore.instrumental,
      'read_file should be epistemic-heavy')

    // 3. selectPolicy → should prefer epistemic tools
    const policies = selectPolicy(efe, scores, { topK: 5 })
    assert.ok(policies.length > 0, 'should have policy options')
    const topNames = policies.map(p => p.toolName)
    assert.ok(
      topNames.slice(0, 3).some(n =>
        ['read_file', 'grep', 'glob', 'repo_map', 'inspect_project'].includes(n)),
      `top-3 should include epistemic tools: ${topNames.slice(0, 3).join(', ')}`,
    )

    // 4. renderAffordanceHint → should produce valid XML with epistemic guidance
    const hint = renderAffordanceHint(state)
    assert.ok(hint.startsWith('<affordance-hint>'), 'should start with XML tag')
    assert.ok(hint.includes('Prefer epistemic tools'),
      'should recommend epistemic tools in early exploration')
    assert.ok(hint.endsWith('</affordance-hint>'), 'should end with XML closing tag')
    assert.ok(hint.includes('read_file') || hint.includes('grep'),
      'should mention specific epistemic tools')

    // 5. renderPolicyGuidance → should produce valid XML
    const guidance = renderPolicyGuidance(policies, efe)
    assert.ok(guidance.startsWith('<policy-guidance>'), 'guidance should start with XML tag')
    assert.ok(guidance.includes('EFE:'), 'guidance should include EFE summary')
    assert.ok(guidance.includes('epistemic='), 'guidance should include epistemic value')
    assert.ok(guidance.endsWith('</policy-guidance>'), 'guidance should end with XML closing tag')
  })

  it('shifts from epistemic to instrumental after consecutive successes', () => {
    // Simulate: 5 consecutive successful tool executions → high confidence
    const state: AffordanceState = {
      sensorium: mockSensorium({ confidence: 0.85, freshness: 0.7 }),
      vigor: mockVigor({ vigor: 0.85 }),
      thetaPhase: 'retrieval',
      season: 'return',
      workingSetSize: 5,
      recentToolNames: ['edit_file', 'bash', 'write_file', 'edit_file', 'bash'],
    }

    // 1. EFE: high confidence + return season → pragmatic > epistemic
    const acc = mockAccumulator([true, true, true, true, true])
    const efe = computeEFE(acc, state.season, state.vigor, state.sensorium)
    assert.ok(efe.pragmaticValue >= efe.epistemicValue,
      `pragmatic ${efe.pragmaticValue} should >= epistemic ${efe.epistemicValue} after 5 successes`)

    // 2. Affordance scores: instrumental tools dominate
    const scores = computeAffordanceScores(state)
    const writeFileScore = scores['write_file']!
    const readFileScore = scores['read_file']!
    assert.ok(writeFileScore.instrumental > readFileScore.instrumental,
      'write_file instrumental should > read_file instrumental')

    // 3. Policy: instrumental tools should rank high
    const policies = selectPolicy(efe, scores, { topK: 5 })
    const topNames = policies.map(p => p.toolName)
    assert.ok(
      topNames.slice(0, 3).some(n => ['write_file', 'edit_file', 'bash', 'run_tests'].includes(n)),
      `top-3 should include instrumental tools: ${topNames.slice(0, 3).join(', ')}`,
    )

    // 4. Affordance hint: should prefer instrumental
    const hint = renderAffordanceHint(state)
    assert.ok(hint.includes('Prefer instrumental tools'),
      'should recommend instrumental tools after consecutive successes')
    assert.ok(hint.includes('confidence is high') || hint.includes('ready to act'),
      'guidance should reflect high confidence')

    // 5. Policy guidance XML format
    const guidance = renderPolicyGuidance(policies, efe)
    assert.ok(guidance.includes('<policy-guidance>'), 'should have opening tag')
    assert.ok(policies[0]!.probability > 0,
      `top policy ${policies[0]!.toolName} should have positive probability`)
  })
  it('adapts affordance from sensorimotor history (multi-session safe)', () => {
    // Capture original registry values to verify they are NOT mutated
    const origBash = { ...toolAffordanceRegistry['bash']! }
    const origReadFile = { ...toolAffordanceRegistry['read_file']! }

    // Simulate: 10 bash failures out of 12 — terrible track record
    const mockGetRate = (toolName: string): number | null => {
      // bash: 2/12 = 0.167 success rate — far below expected 1.0 for instrumental tools
      if (toolName === 'bash') return 0.17
      // read_file: 11/12 = 0.917 — slightly below expected 0.95 for epistemic tools
      if (toolName === 'read_file') return 0.92
      return null
    }

    // Returns session-local adapted map — does NOT mutate global registry
    const adapted = adaptAffordanceFromHistory(mockGetRate)

    // Global registry must be unchanged (multi-session safety)
    assert.equal(toolAffordanceRegistry['bash']!.instrumental, origBash.instrumental,
      'global registry must not be mutated')
    assert.equal(toolAffordanceRegistry['bash']!.epistemic, origBash.epistemic,
      'global registry must not be mutated')
    assert.equal(toolAffordanceRegistry['read_file']!.epistemic, origReadFile.epistemic,
      'global registry must not be mutated')

    // Adapted map: bash instrumental should decrease, epistemic increase
    const adaptedBash = adapted['bash']!
    assert.ok(adaptedBash.instrumental < origBash.instrumental,
      `bash instrumental should decrease: ${adaptedBash.instrumental} < ${origBash.instrumental}`)
    assert.ok(adaptedBash.epistemic > origBash.epistemic,
      `bash epistemic should increase: ${adaptedBash.epistemic} > ${origBash.epistemic}`)

    // read_file: slight deviation (0.92 vs expected 0.95, diff=0.03 < 0.15) → not in adapted map
    assert.equal(adapted['read_file'], undefined,
      'read_file should not be in adapted map (deviation below threshold)')

    // Passing adaptations to computeAffordanceScores should affect the output
    const state: AffordanceState = {
      sensorium: mockSensorium({ confidence: 0.9 }),
      vigor: mockVigor({ vigor: 0.9 }),
      thetaPhase: 'retrieval',
      season: 'return',
      workingSetSize: 3,
      recentToolNames: ['bash', 'edit_file'],
    }
    const scoresWithAdapt = computeAffordanceScores(state, adapted)

    // bash instrumental should be lower due to adaptation
    const adaptedBashScore = scoresWithAdapt['bash']!
    const editFileScore = scoresWithAdapt['edit_file']!
    assert.ok(
      editFileScore.instrumental >= adaptedBashScore.instrumental,
      `edit_file instrumental ${editFileScore.instrumental} should >= bash instrumental ${adaptedBashScore.instrumental}`,
    )
  })
  it('returns empty hint when both sensorium and vigor are null (no cognitive state)', () => {
    const state = mockAffordanceState()
    const hint = renderAffordanceHint(state)
    assert.equal(hint, '', 'should return empty string when no sensorium and no vigor')

    // Full pipeline with null state: computeEFE should degrade gracefully
    const acc = mockAccumulator([])
    const efe = computeEFE(acc, null, null, null)
    assert.ok(efe.epistemicValue >= 0, 'epistemicValue should degrade gracefully')
    assert.ok(efe.pragmaticValue >= 0, 'pragmaticValue should degrade gracefully')
    assert.ok(efe.precision >= 0.3, 'precision should floor at 0.3')

    // Affordance scores with null state should still produce valid output
    const scores = computeAffordanceScores(state)
    assert.ok(Object.keys(scores).length > 0, 'should still produce affordance scores')
    for (const [name, score] of Object.entries(scores)) {
      assert.ok(score.epistemic >= 0 && score.epistemic <= 1,
        `${name} epistemic ${score.epistemic} should be in [0,1]`)
      assert.ok(score.instrumental >= 0 && score.instrumental <= 1,
        `${name} instrumental ${score.instrumental} should be in [0,1]`)
    }

    // Policy selection with null-derived EFE should still work
    const policies = selectPolicy(efe, scores, { topK: 3 })
    assert.ok(Array.isArray(policies), 'should return an array')
    assert.ok(policies.length > 0, 'should return at least one policy')
    assert.equal(policies.length, 3, 'should respect topK')
  })

  it('softmax policy probabilities are valid probability distributions', () => {
    // With asymmetric tools, specific tools should dominate
    const state: AffordanceState = {
      sensorium: mockSensorium({ confidence: 0.2, freshness: 0.3 }),
      vigor: null,
      thetaPhase: 'encoding',
      season: 'genesis',
      workingSetSize: 0,
      recentToolNames: [], // empty history
    }
    const acc = mockAccumulator([true])
    const efe = computeEFE(acc, state.season, state.vigor, state.sensorium)
    const scores = computeAffordanceScores(state)

    // Full distribution (all tools, not just top-K) must sum to ~1
    const allPolicies = selectPolicy(efe, scores, { topK: 100 })
    const sum = allPolicies.reduce((s, p) => s + p.probability, 0)
    assert.ok(Math.abs(sum - 1.0) < 0.001,
      `full distribution sum ${sum} should ≈ 1.0`)

    // Every probability must be in valid range
    for (const p of allPolicies) {
      assert.ok(p.probability >= 0 && p.probability <= 1,
        `${p.toolName} probability ${p.probability} should be in [0,1]`)
    }

    // Expected Free Energy G values should be negative for dominant tools
    // (since computeG returns -(epistemicValue * a.epistemic + pragmaticValue * a.instrumental),
    //  and all components are positive)
    for (const p of allPolicies) {
      assert.ok(typeof p.expectedFreeEnergy === 'number',
        `${p.toolName} G should be a number`)
    }

    // Tools with higher G (less negative) should have lower probability
    for (let i = 1; i < allPolicies.length; i++) {
      assert.ok(allPolicies[i - 1]!.probability >= allPolicies[i]!.probability,
        `policies should be sorted: ${allPolicies[i - 1]!.toolName} (${allPolicies[i - 1]!.probability}) >= ${allPolicies[i]!.toolName} (${allPolicies[i]!.probability})`)
    }
  })

  it('handles empty recentToolNames — contextual modulator baseline', () => {
    // Empty recentToolNames: no repetition penalty, no working-set bias for file tools
    const stateNoWs: AffordanceState = {
      sensorium: mockSensorium({ confidence: 0.5 }),
      vigor: null,
      thetaPhase: null,
      season: null,
      workingSetSize: 0,
      recentToolNames: [],
    }
    const scoresNoWs = computeAffordanceScores(stateNoWs)

    // With empty working set, all contextual scores should be at baseline (0.5 ± offset)
    for (const [name, score] of Object.entries(scoresNoWs)) {
      assert.ok(score.contextual >= 0 && score.contextual <= 1,
        `${name} contextual ${score.contextual} should be in [0,1]`)
    }

    // File tools should not be boosted without working set
    const rfNoWs = scoresNoWs['read_file']!
    const wfNoWs = scoresNoWs['write_file']!

    // With working set: file tools get +0.2 contextual boost
    const stateWithWs: AffordanceState = {
      sensorium: mockSensorium({ confidence: 0.5 }),
      vigor: null,
      thetaPhase: null,
      season: null,
      workingSetSize: 5,
      recentToolNames: [],
    }
    const scoresWithWs = computeAffordanceScores(stateWithWs)
    const rfWithWs = scoresWithWs['read_file']!

    assert.ok(rfWithWs.contextual > rfNoWs.contextual,
      `read_file contextual should boost with working set: ${rfWithWs.contextual} > ${rfNoWs.contextual}`)

    // No repetition penalty since recentToolNames is empty
    // (baseline contextual for grep is same as read_file without working set)
    assert.equal(rfNoWs.contextual, 0.5,
      'baseline contextual should be 0.5 with no working set and empty history')
  })

  it('produces valid XML blocks within token budget', () => {
    const state: AffordanceState = {
      sensorium: mockSensorium({ confidence: 0.6, freshness: 0.5 }),
      vigor: mockVigor({ vigor: 0.6 }),
      thetaPhase: 'encoding',
      season: 'return',
      workingSetSize: 3,
      recentToolNames: ['read_file', 'grep', 'edit_file', 'bash'],
    }

    // 1. Compute full pipeline
    const acc = mockAccumulator([true, true, true, false, true])
    const efe = computeEFE(acc, state.season, state.vigor, state.sensorium)
    const scores = computeAffordanceScores(state)
    const policies = selectPolicy(efe, scores, { topK: 5 })

    // 2. Generate both XML blocks
    const hint = renderAffordanceHint(state)
    const guidance = renderPolicyGuidance(policies, efe)

    // 3. Hint XML validation
    assert.ok(hint.startsWith('<affordance-hint>\n'), 'hint should start with opening tag')
    assert.ok(hint.endsWith('\n</affordance-hint>'), 'hint should end with closing tag')
    const hintInner = hint.slice('<affordance-hint>\n'.length, -'\n</affordance-hint>'.length)
    assert.ok(!hintInner.includes(' < '), 'hint inner should not have unescaped <')
    assert.ok(!hintInner.includes(' > '), 'hint inner should not have unescaped >')
    assert.ok(!hintInner.includes(' & '), 'hint inner should not have unescaped &')

    // 4. Guidance XML validation
    assert.ok(guidance.length > 0, 'guidance should not be empty')
    assert.ok(guidance.startsWith('<policy-guidance>\n'), 'guidance should start with opening tag')
    assert.ok(guidance.endsWith('\n</policy-guidance>'), 'guidance should end with closing tag')
    const guidanceInner = guidance.slice('<policy-guidance>\n'.length, -'\n</policy-guidance>'.length)
    assert.ok(!guidanceInner.includes(' < '), 'guidance inner should not have unescaped <')
    assert.ok(!guidanceInner.includes(' > '), 'guidance inner should not have unescaped >')

    // 5. Token budget: combined XML length < 500 tokens (~2000 chars)
    const combinedLength = hint.length + guidance.length
    assert.ok(combinedLength < 2000,
      `combined XML length ${combinedLength} should be < 2000 chars (~500 tokens)`)

    // 6. Both blocks are independently valid XML fragments
    const hintCount = (hint.match(/<affordance-hint>/g) || []).length
    const hintCloseCount = (hint.match(/<\/affordance-hint>/g) || []).length
    const guidanceOpenCount = (guidance.match(/<policy-guidance>/g) || []).length
    const guidanceCloseCount = (guidance.match(/<\/policy-guidance>/g) || []).length
    assert.equal(hintCount, 1, 'should have exactly 1 affordance-hint')
    assert.equal(hintCloseCount, 1, 'affordance-hint should be closed exactly once')
    assert.equal(guidanceOpenCount, 1, 'should have exactly 1 policy-guidance')
    assert.equal(guidanceCloseCount, 1, 'policy-guidance should be closed exactly once')

    // 7. EFE values in guidance match computed values
    assert.ok(guidance.includes(`epistemic=${efe.epistemicValue.toFixed(2)}`),
      'guidance should reflect computed epistemic value')
    assert.ok(guidance.includes(`pragmatic=${efe.pragmaticValue.toFixed(2)}`),
      'guidance should reflect computed pragmatic value')
  })
})
