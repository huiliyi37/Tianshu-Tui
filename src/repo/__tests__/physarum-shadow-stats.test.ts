import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  aggregatePhysarumPredictionObservations,
  getPhysarumShadowStatsFromDb,
} from '../physarum-shadow-stats.js'
import type { PhysarumPredictionObservation } from '../physarum-types.js'

describe('physarum shadow stats', () => {
  it('aggregates shadow next-step hit@1 and hit@3 from persisted observations', () => {
    const observations: PhysarumPredictionObservation[] = [
      {
        sourceFile: 'src/a.ts',
        predictedAtTurn: 1,
        predictions: [{ file: 'src/b.ts', score: 1 }],
        observedFile: 'src/b.ts',
        observedAtTurn: 2,
        hitRank: 1,
        leadTurns: 1,
      },
      {
        sourceFile: 'src/b.ts',
        predictedAtTurn: 2,
        predictions: [{ file: 'src/c.ts', score: 1 }, { file: 'src/d.ts', score: 0.8 }, { file: 'src/e.ts', score: 0.6 }],
        observedFile: 'src/e.ts',
        observedAtTurn: 3,
        hitRank: 3,
        leadTurns: 1,
      },
      {
        sourceFile: 'src/e.ts',
        predictedAtTurn: 3,
        predictions: [{ file: 'src/f.ts', score: 1 }],
        observedFile: 'src/g.ts',
        observedAtTurn: 4,
        hitRank: null,
        leadTurns: 1,
      },
    ]

    const stats = aggregatePhysarumPredictionObservations(observations)

    assert.equal(stats.semantic, 'next-step')
    assert.equal(stats.total, 3)
    assert.equal(stats.hit1, 1)
    assert.equal(stats.hit3, 2)
    assert.equal(stats.miss, 1)
    assert.equal(stats.hitAt1, 1 / 3)
    assert.equal(stats.hitAt3, 2 / 3)
  })

  it('returns zero shadow stats for empty observations', () => {
    const stats = aggregatePhysarumPredictionObservations([])

    assert.equal(stats.total, 0)
    assert.equal(stats.hit1, 0)
    assert.equal(stats.hit3, 0)
    assert.equal(stats.miss, 0)
    assert.equal(stats.hitAt1, 0)
    assert.equal(stats.hitAt3, 0)
  })

  it('keeps DB unavailable paths no-op', () => {
    const stats = getPhysarumShadowStatsFromDb(null)

    assert.equal(stats.semantic, 'next-step')
    assert.equal(stats.total, 0)
    assert.equal(stats.hitAt1, 0)
    assert.equal(stats.hitAt3, 0)
  })
})
