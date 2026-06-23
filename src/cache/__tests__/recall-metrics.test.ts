import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { RecallMetrics } from '../recall-metrics.js'
import { CacheAdvisor } from '../advisor.js'

describe('RecallMetrics', () => {
  it('records recalls and computes turn distance from the archive turn', () => {
    const m = new RecallMetrics()
    m.registerArchive('compact-history:a', 10)
    m.recordRecall('compact-history:a', 14)
    m.recordRecall('compact-history:a', 20)

    const summary = m.getSummary()
    assert.equal(summary.totalRecalls, 2)
    assert.equal(summary.uniqueArtifacts, 1)
    assert.equal(summary.avgTurnDistance, (4 + 10) / 2)
    assert.equal(summary.maxTurnDistance, 10)
  })

  it('records null turn distance when archive turn is unknown', () => {
    const m = new RecallMetrics()
    m.recordRecall('compact-history:unknown', 5)
    const summary = m.getSummary()
    assert.equal(summary.totalRecalls, 1)
    assert.equal(summary.avgTurnDistance, null)
    assert.equal(summary.maxTurnDistance, null)
  })

  it('starts empty', () => {
    const summary = new RecallMetrics().getSummary()
    assert.deepEqual(summary, { totalRecalls: 0, uniqueArtifacts: 0, avgTurnDistance: null, maxTurnDistance: null })
  })
})

describe('CacheAdvisor recall observability', () => {
  it('records a recall only for compact-history artifact accesses', () => {
    const advisor = new CacheAdvisor({ providerProfile: { cacheType: 'exact-prefix', persistent: true } })
    advisor.registerArchive('compact-history:h1', 3)

    advisor.onTurnEnd({
      turn: 8,
      cacheRead: 100,
      cacheCreation: 0,
      prefixChanged: false,
      artifactIdsEvicted: [],
      artifactIdsAccessed: ['compact-history:h1', 'read_file:other'],
    })

    const summary = advisor.getRecallSummary()
    assert.equal(summary.totalRecalls, 1, 'only the compact-history access counts as a recall')
    assert.equal(summary.uniqueArtifacts, 1)
    assert.equal(summary.maxTurnDistance, 5)
  })

  it('surfaces the recall summary through getDiagnostic (A2)', () => {
    const advisor = new CacheAdvisor({ providerProfile: { cacheType: 'exact-prefix', persistent: true } })
    advisor.registerArchive('compact-history:h1', 2)
    advisor.onTurnEnd({
      turn: 9,
      cacheRead: 50,
      cacheCreation: 0,
      prefixChanged: false,
      artifactIdsEvicted: [],
      artifactIdsAccessed: ['compact-history:h1'],
    })

    const diag = advisor.getDiagnostic()
    assert.ok(diag.recall, 'diagnostic must carry a recall summary')
    assert.equal(diag.recall.totalRecalls, 1)
    assert.equal(diag.recall.maxTurnDistance, 7)
  })
})
