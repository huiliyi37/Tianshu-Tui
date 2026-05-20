import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  classifySeason,
  type SeasonInput,
} from '../cognitive-season.js'
import { buildCognitiveMirror, createCognitiveLedger } from '../../context/cognitive-ledger.js'

function makeInput(overrides: Partial<SeasonInput> = {}): SeasonInput {
  return {
    turn: 10,
    doomLevel: 'none',
    recentCompactTurn: null,
    sensoriumStability: 0.7,
    ...overrides,
  }
}

describe('cognitive-season', () => {
  describe('genesis — 生成期（弱者道之用）', () => {
    it('returns genesis in first 5 turns', () => {
      const result = classifySeason(makeInput({ turn: 1 }))
      assert.equal(result.season, 'genesis')
    })

    it('returns genesis at turn 5 boundary', () => {
      const result = classifySeason(makeInput({ turn: 5 }))
      assert.equal(result.season, 'genesis')
    })

    it('genesis intensity decreases as turn increases', () => {
      const early = classifySeason(makeInput({ turn: 1 }))
      const late = classifySeason(makeInput({ turn: 5 }))
      assert.ok(early.intensity > late.intensity,
        `turn 1 intensity ${early.intensity} should exceed turn 5 intensity ${late.intensity}`)
    })

    it('genesis at turn 1 has full intensity', () => {
      const result = classifySeason(makeInput({ turn: 1 }))
      assert.equal(result.intensity, 1.0)
    })
  })

  describe('reversal — 反转期（反者道之动）', () => {
    it('returns reversal when doom level is blocked', () => {
      const result = classifySeason(makeInput({ turn: 15, doomLevel: 'blocked' }))
      assert.equal(result.season, 'reversal')
    })

    it('reversal at blocked has full intensity', () => {
      const result = classifySeason(makeInput({ turn: 15, doomLevel: 'blocked' }))
      assert.equal(result.intensity, 1.0)
    })

    it('returns reversal at warn with partial intensity (thermocline)', () => {
      const result = classifySeason(makeInput({ turn: 15, doomLevel: 'warn' }))
      assert.equal(result.season, 'reversal')
      assert.ok(result.intensity > 0 && result.intensity < 1.0,
        `warn intensity ${result.intensity} should be between 0 and 1`)
    })

    it('reversal overrides genesis even in early turns', () => {
      const result = classifySeason(makeInput({ turn: 3, doomLevel: 'blocked' }))
      assert.equal(result.season, 'reversal')
    })
  })

  describe('return — 复归期（复归于朴）', () => {
    it('returns return immediately after compact', () => {
      const result = classifySeason(makeInput({ turn: 20, recentCompactTurn: 20 }))
      assert.equal(result.season, 'return')
    })

    it('returns return within 3-turn window after compact', () => {
      const result = classifySeason(makeInput({ turn: 22, recentCompactTurn: 20 }))
      assert.equal(result.season, 'return')
    })

    it('return intensity fades over the 3-turn window', () => {
      const immediate = classifySeason(makeInput({ turn: 20, recentCompactTurn: 20 }))
      const later = classifySeason(makeInput({ turn: 22, recentCompactTurn: 20 }))
      assert.ok(immediate.intensity > later.intensity,
        `immediate ${immediate.intensity} should exceed later ${later.intensity}`)
    })

    it('return window expires after 3 turns', () => {
      const result = classifySeason(makeInput({ turn: 24, recentCompactTurn: 20 }))
      assert.notEqual(result.season, 'return')
    })

    it('reversal overrides return (doom during recovery)', () => {
      const result = classifySeason(makeInput({
        turn: 21, recentCompactTurn: 20, doomLevel: 'blocked',
      }))
      assert.equal(result.season, 'reversal')
    })
  })

  describe('wuwei — 无为期（道常无为而无不为）', () => {
    it('returns wuwei in stable long session', () => {
      const result = classifySeason(makeInput({
        turn: 30, doomLevel: 'none', recentCompactTurn: null, sensoriumStability: 0.8,
      }))
      assert.equal(result.season, 'wuwei')
    })

    it('wuwei requires stability >= 0.6', () => {
      const unstable = classifySeason(makeInput({
        turn: 30, sensoriumStability: 0.4,
      }))
      assert.notEqual(unstable.season, 'wuwei')
    })

    it('wuwei intensity scales with stability', () => {
      const moderate = classifySeason(makeInput({ turn: 30, sensoriumStability: 0.6 }))
      const high = classifySeason(makeInput({ turn: 30, sensoriumStability: 0.9 }))
      assert.ok(high.intensity >= moderate.intensity,
        `high stability ${high.intensity} should >= moderate ${moderate.intensity}`)
    })
  })

  describe('fallback — genesis when no other season matches', () => {
    it('returns genesis for unstable mid-session without doom or compact', () => {
      const result = classifySeason(makeInput({
        turn: 15, doomLevel: 'none', recentCompactTurn: null, sensoriumStability: 0.3,
      }))
      assert.equal(result.season, 'genesis')
    })
  })

  describe('season output structure', () => {
    it('always returns season and intensity', () => {
      const result = classifySeason(makeInput())
      assert.ok('season' in result)
      assert.ok('intensity' in result)
      assert.ok(typeof result.season === 'string')
      assert.ok(typeof result.intensity === 'number')
    })

    it('intensity is always 0-1', () => {
      const inputs: SeasonInput[] = [
        makeInput({ turn: 1 }),
        makeInput({ turn: 50, doomLevel: 'blocked' }),
        makeInput({ turn: 20, recentCompactTurn: 20 }),
        makeInput({ turn: 100, sensoriumStability: 1.0 }),
      ]
      for (const input of inputs) {
        const result = classifySeason(input)
        assert.ok(result.intensity >= 0 && result.intensity <= 1,
          `intensity ${result.intensity} out of range for ${JSON.stringify(input)}`)
      }
    })
  })

  describe('cognitive mirror integration', () => {
    const baseLedgerInput = {
      evidence: {
        filesRead: new Set<string>(),
        filesModified: new Set<string>(),
        verifications: [],
        deliveryStatus: 'unverified' as const,
        impactedFiles: new Set<string>(),
        impactedTests: new Set<string>(),
      },
      trace: { maxEvents: 100, events: [], toolFingerprints: [] },
      turn: 3,
      sensorium: { confidence: 0.7, complexity: 0.5, momentum: 0.6, stability: 0.8, freshness: 0.5, pressure: 0.3 },
    }

    it('season appears in cognitive mirror output', () => {
      const ledger = createCognitiveLedger({ ...baseLedgerInput, season: 'genesis' })
      const mirror = buildCognitiveMirror(ledger)
      assert.ok(mirror.includes('season="genesis"'), `mirror should include season: ${mirror}`)
    })

    it('season is omitted from mirror when null', () => {
      const ledger = createCognitiveLedger({ ...baseLedgerInput, season: null })
      const mirror = buildCognitiveMirror(ledger)
      assert.ok(!mirror.includes('season='), `mirror should not include season: ${mirror}`)
    })
  })
})
