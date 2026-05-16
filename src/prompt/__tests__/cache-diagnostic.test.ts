import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { diagnoseCacheMiss } from '../cache-diagnostic.js'

describe('diagnoseCacheMiss', () => {
  it('reports low hit rate on latest turn', () => {
    const diagnostic = diagnoseCacheMiss([
      { turn: 1, cacheRead: 20, cacheCreation: 80, inputTokens: 100, outputTokens: 10 },
    ], 1, null, false)

    assert.ok(diagnostic)
    assert.match(diagnostic!.message, /cache/i)
  })

  it('returns null when hit rate is healthy', () => {
    const diagnostic = diagnoseCacheMiss([
      { turn: 1, cacheRead: 20, cacheCreation: 80, inputTokens: 100, outputTokens: 10 },
      { turn: 2, cacheRead: 90, cacheCreation: 10, inputTokens: 100, outputTokens: 10 },
    ], 2, null, false)

    assert.equal(diagnostic, null)
  })
})
