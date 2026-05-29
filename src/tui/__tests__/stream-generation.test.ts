import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { isCurrentGeneration } from '../app.js'

describe('isCurrentGeneration — stream generation guard', () => {
  it('allows flip when the run is still the current generation', () => {
    assert.equal(isCurrentGeneration(2, 2), true)
  })

  it('rejects flip from a stale (older) run after a newer run started', () => {
    // Run A captured gen 1; user submitted run B → current gen is 2.
    // A's late onAbort/onError must NOT flip isStreaming off on B.
    assert.equal(isCurrentGeneration(1, 2), false)
  })

  it('rejects the original bug: a guard keyed on an unset ref (-1) never matches', () => {
    // The broken onError guard compared abortedAtGenRef (stuck at -1 on a
    // spontaneous error) against the current gen, so it never flipped and froze
    // the UI in streaming. The current-generation check must reject -1.
    assert.equal(isCurrentGeneration(-1, 1), false)
  })
})
