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

  it('adapts affordance from sensorimotor history', () => {
    // Save original values to restore after test
    const origBash = { ...toolAffordanceRegistry['bash']! }
    const origReadFile = { ...toolAffordanceRegistry['read_file']! }

    try {
      // Simulate: 10 bash failures out of 12 — terrible track record
      const mockGetRate = (toolName: string): number | null => {
        // bash: 2/12 = 0.167 success rate — far below expected 1.0 for instrumental tools
        if (toolName === 'bash') return 0.17
        // read_file: 11/12 = 0.917 — slightly below expected 0.95 for epistemic tools
        if (toolName === 'read_file') return 0.92
        return null
      }

      adaptAffordanceFromHistory(mockGetRate)

      // bash: instrumental should decrease, epistemic should increase
      const adaptedBash = toolAffordanceRegistry['bash']!
      assert.ok(adaptedBash.instrumental < origBash.instrumental,
        `bash instrumental should decrease: ${adaptedBash.instrumental} < ${origBash.instrumental}`)
      assert.ok(adaptedBash.epistemic > origBash.epistemic,
        `bash epistemic should increase: ${adaptedBash.epistemic} > ${origBash.epistemic}`)

      // read_file: slight deviation (0.92 vs expected 0.95, diff=0.03 < 0.15) → no change
      const adaptedReadFile = toolAffordanceRegistry['read_file']!
      assert.equal(adaptedReadFile.epistemic, origReadFile.epistemic,
        'read_file should be unchanged (deviation below threshold)')
      assert.equal(adaptedReadFile.instrumental, origReadFile.instrumental,
        'read_file instrumental should be unchanged')

      // Verify adapted registry affects affordance rendering
      const state: AffordanceState = {
        sensorium: mockSensorium({ confidence: 0.9 }),
        vigor: mockVigor({ vigor: 0.9 }),
        thetaPhase: 'retrieval',
        season: 'return',
        workingSetSize: 3,
        recentToolNames: ['bash', 'edit_file'],
      }
      const scores = computeAffordanceScores(state)

      // bash instrumental should be lower due to adaptation
      const adaptedBashScore = scores['bash']!
      const editFileScore = scores['edit_file']!
      assert.ok(
        editFileScore.instrumental >= adaptedBashScore.instrumental,
        `edit_file instrumental ${editFileScore.instrumental} should >= bash instrumental ${adaptedBashScore.instrumental}`,
      )
    } finally {
      // Restore original values to avoid side effects on other tests
      toolAffordanceRegistry['bash'] = origBash
      toolAffordanceRegistry['read_file'] = origReadFile
    }
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
