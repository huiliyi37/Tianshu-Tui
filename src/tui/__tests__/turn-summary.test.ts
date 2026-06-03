import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { formatTurnSummary } from '../turn-summary.js'
import type { PhaseSegment } from '../../agent/chronicle.js'

function seg(phase: PhaseSegment['phase']): PhaseSegment {
  return { phase, startTurn: 0, startTimestamp: 0, entries: [] }
}

describe('formatTurnSummary', () => {
  it('joins phase glyphs with arrows', () => {
    const out = formatTurnSummary({
      turnNumber: 1,
      segments: [seg('tianshu-planning'), seg('yuheng-implementing'), seg('kaiyang-testing')],
      filesRead: 5, filesModified: 3, verifiedCount: 1, elapsedMs: 134_000,
    })
    assert.match(out, /⭐.*→.*🔨.*→.*⚔️/)
    assert.match(out, /读5 改3/)
    assert.match(out, /✓1/)
    assert.match(out, /2m14s/)
  })

  it('falls back to a marker when no segments', () => {
    const out = formatTurnSummary({ turnNumber: 1, segments: [], filesRead: 0, filesModified: 0, verifiedCount: 0, elapsedMs: 1000 })
    assert.match(out, /·/) // still a single-line anchor, no crash
    assert.match(out, /1s/)
  })

  it('omits the verify token when verifiedCount is 0', () => {
    const out = formatTurnSummary({ turnNumber: 1, segments: [seg('tianshu-planning')], filesRead: 1, filesModified: 0, verifiedCount: 0, elapsedMs: 2000 })
    assert.ok(!out.includes('✓'))
  })
})
