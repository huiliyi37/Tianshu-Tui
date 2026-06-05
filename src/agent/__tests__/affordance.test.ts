import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  toolAffordanceRegistry,
  getBaseAffordance,
  computeAffordanceScores,
  renderAffordanceHint,
  adaptAffordanceFromHistory,
  type AffordanceState,
} from '../affordance.js'

describe('toolAffordanceRegistry', () => {
  it('has known tool entries', () => {
    assert.ok(toolAffordanceRegistry['read_file'])
    assert.ok(toolAffordanceRegistry['write_file'])
    assert.ok(toolAffordanceRegistry['bash'])
    assert.ok(toolAffordanceRegistry['grep'])
  })

  it('read tools are epistemic-heavy', () => {
    const rf = toolAffordanceRegistry['read_file']!
    assert.ok(rf.epistemic > rf.instrumental, 'read_file should be epistemic-heavy')
    assert.ok(rf.epistemic >= 0.8)
  })

  it('write tools are instrumental-heavy', () => {
    const wf = toolAffordanceRegistry['write_file']!
    assert.ok(wf.instrumental > wf.epistemic, 'write_file should be instrumental-heavy')
    assert.equal(wf.epistemic, 0.0)
  })

  it('getBaseAffordance returns default for unknown tools', () => {
    const unknown = getBaseAffordance('nonexistent_tool')
    assert.equal(unknown.epistemic, 0.5)
    assert.equal(unknown.instrumental, 0.5)
  })
})

describe('computeAffordanceScores', () => {
  const baseState: AffordanceState = {
    sensorium: null,
    vigor: null,
    thetaPhase: null,
    season: null,
    workingSetSize: 0,
    recentToolNames: [],
  }

  it('returns scores for all registered tools', () => {
    const scores = computeAffordanceScores(baseState)
    assert.ok(Object.keys(scores).length > 30, 'should have many tools')
    // Every score should have the three fields
    for (const [, score] of Object.entries(scores)) {
      assert.ok(typeof score.epistemic === 'number')
      assert.ok(typeof score.instrumental === 'number')
      assert.ok(typeof score.contextual === 'number')
      assert.ok(score.epistemic >= 0 && score.epistemic <= 1)
      assert.ok(score.instrumental >= 0 && score.instrumental <= 1)
      assert.ok(score.contextual >= 0 && score.contextual <= 1)
    }
  })

  it('boosts epistemic when theta is encoding', () => {
    const encoding = computeAffordanceScores({ ...baseState, thetaPhase: 'encoding' })
    const retrieval = computeAffordanceScores({ ...baseState, thetaPhase: 'retrieval' })
    const rfEnc = encoding['read_file']!
    const rfRet = retrieval['read_file']!
    assert.ok(rfEnc.epistemic >= rfRet.epistemic, 'encoding should boost epistemic')
  })

  it('dampens instrumental in wuwei season', () => {
    const normal = computeAffordanceScores({ ...baseState, season: 'genesis' })
    const wuwei = computeAffordanceScores({ ...baseState, season: 'wuwei' })
    const wfNorm = normal['write_file']!
    const wfWw = wuwei['write_file']!
    assert.ok(wfNorm.instrumental >= wfWw.instrumental, 'wuwei should dampen instrumental')
  })

  it('contextual boosts file tools when working set is non-empty', () => {
    const emptyWs = computeAffordanceScores({ ...baseState, workingSetSize: 0 })
    const fullWs = computeAffordanceScores({ ...baseState, workingSetSize: 5 })
    assert.ok(fullWs['read_file']!.contextual >= emptyWs['read_file']!.contextual)
  })

  it('recent tool repetition reduces contextual', () => {
    const fresh = computeAffordanceScores({
      ...baseState,
      recentToolNames: ['grep', 'glob', 'repo_map'],
    })
    const repeated = computeAffordanceScores({
      ...baseState,
      recentToolNames: ['grep', 'grep', 'grep'],
    })
    assert.ok(repeated['grep']!.contextual <= fresh['grep']!.contextual,
      'repeated tools should have lower contextual')
  })
})

describe('renderAffordanceHint', () => {
  it('returns empty string when no sensorium and no vigor', () => {
    const result = renderAffordanceHint({
      sensorium: null,
      vigor: null,
      thetaPhase: null,
      season: null,
      workingSetSize: 0,
      recentToolNames: [],
    })
    assert.equal(result, '')
  })

  it('returns XML block with cognitive state when state is available', () => {
    const result = renderAffordanceHint({
      sensorium: {
        momentum: 0.5,
        pressure: 0.3,
        confidence: 0.3,
        complexity: 0.4,
        freshness: 0.6,
        stability: 0.7,
      },
      vigor: { tonic: 0.6, phasic: 0.1, curiosity: 0.4, vigor: 0.7, variability: 0.1, history: [] },
      thetaPhase: 'encoding',
      season: 'genesis',
      workingSetSize: 3,
      recentToolNames: ['read_file', 'grep'],
    })
    assert.ok(result.startsWith('<affordance-hint>'))
    assert.ok(result.includes('Cognitive state:'))
    assert.ok(result.includes('theta=encoding'))
    assert.ok(result.includes('season=genesis'))
    assert.ok(result.endsWith('</affordance-hint>'))
  })

  it('prefers epistemic tools when uncertainty is high', () => {
    const result = renderAffordanceHint({
      sensorium: {
        momentum: 0.2,
        pressure: 0.3,
        confidence: 0.1, // very low confidence → high uncertainty
        complexity: 0.3,
        freshness: 0.5,
        stability: 0.5,
      },
      vigor: null,
      thetaPhase: 'encoding',
      season: 'genesis',
      workingSetSize: 0,
      recentToolNames: [],
    })
    assert.ok(result.includes('Prefer epistemic tools'))
    // Should include epistemic tools like read_file, grep, glob
    assert.ok(
      result.includes('read_file') || result.includes('grep') || result.includes('glob'),
      'should recommend epistemic tools'
    )
  })

  it('prefers instrumental tools when confidence is high', () => {
    const result = renderAffordanceHint({
      sensorium: {
        momentum: 0.8,
        pressure: 0.2,
        confidence: 0.9, // very high confidence
        complexity: 0.2,
        freshness: 0.5,
        stability: 0.8,
      },
      vigor: { tonic: 0.8, phasic: 0.2, curiosity: 0.3, vigor: 0.85, variability: 0.1, history: [] },
      thetaPhase: 'retrieval',
      season: 'return',
      workingSetSize: 3,
      recentToolNames: [],
    })
    assert.ok(result.includes('Prefer instrumental tools'))
  })

  it('escapes XML special characters', () => {
    // Test that special chars don't break XML
    const result = renderAffordanceHint({
      sensorium: {
        momentum: 0.5,
        pressure: 0.3,
        confidence: 0.5,
        complexity: 0.4,
        freshness: 0.6,
        stability: 0.7,
      },
      vigor: null,
      thetaPhase: 'encoding',
      season: 'genesis',
      workingSetSize: 0,
      recentToolNames: [],
    })
    // Should not contain raw < > &
    const inner = result.replace(/^<affordance-hint>\n/, '').replace(/\n<\/affordance-hint>$/, '')
    assert.ok(!inner.includes(' < '), 'should not have unescaped <')
    assert.ok(!inner.includes(' > '), 'should not have unescaped >')
  })
})

describe('adaptAffordanceFromHistory', () => {
  it('returns adapted map when actual success rate deviates from expected (multi-session safe)', () => {
    const origBash = { ...toolAffordanceRegistry['bash']! }

    const mockGetRate = (name: string): number | null => {
      if (name === 'bash') return 0.7
      if (name === 'read_file') return 0.98
      return null
    }

    const adapted = adaptAffordanceFromHistory(mockGetRate)

    // Global registry must be unchanged
    assert.equal(toolAffordanceRegistry['bash']!.instrumental, origBash.instrumental,
      'global registry must not be mutated')

    // Adapted map: bash instrumental should decrease
    const adaptedBash = adapted['bash']!
    assert.ok(adaptedBash.instrumental < origBash.instrumental,
      'bash instrumental should decrease')
    assert.ok(adaptedBash.epistemic > origBash.epistemic,
      'bash epistemic should increase')

    // read_file: 0.98 vs expected 0.95, diff=0.03 < 0.15 → not in adapted map
    assert.equal(adapted['read_file'], undefined,
      'read_file should not be in adapted map (below threshold)')
  })

  it('returns empty map when no tools have enough data', () => {
    const adapted = adaptAffordanceFromHistory(() => null)
    assert.deepEqual(adapted, {})
  })
})

