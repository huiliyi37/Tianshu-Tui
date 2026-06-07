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
    // Turn number and elapsed are intentionally NOT in this marker — the live
    // footer (GlanceBar) owns elapsed; the turn count is sequential noise.
    assert.ok(!/Turn/.test(out))
    assert.ok(!/2m14s/.test(out))
  })

  it('falls back to a file marker when no segments', () => {
    const out = formatTurnSummary({ turnNumber: 1, segments: [], filesRead: 0, filesModified: 0, verifiedCount: 0, elapsedMs: 1000 })
    assert.match(out, /读0 改0/) // still a single-line anchor, no crash
  })

  it('omits the verify token when verifiedCount is 0', () => {
    const out = formatTurnSummary({ turnNumber: 1, segments: [seg('tianshu-planning')], filesRead: 1, filesModified: 0, verifiedCount: 0, elapsedMs: 2000 })
    assert.ok(!out.includes('✓'))
  })
})
