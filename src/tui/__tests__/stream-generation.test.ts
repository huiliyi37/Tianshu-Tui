import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { estimateLiveChromeRows, isCurrentGeneration, shouldUseStaticHistory } from '../app.js'

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

describe('shouldUseStaticHistory', () => {
  it('keeps Static during streaming when terminal diff rendering is supported', () => {
    assert.equal(shouldUseStaticHistory(true, true), true)
  })

  it('disables Static during streaming when ANSI cursor diff rendering is unavailable', () => {
    assert.equal(shouldUseStaticHistory(true, false), false)
  })

  it('restores Static after streaming even without ANSI cursor diff rendering', () => {
    assert.equal(shouldUseStaticHistory(false, false), true)
  })
})

describe('estimateLiveChromeRows', () => {
  it('counts full-width thinking text by display rows', () => {
    const rows = estimateLiveChromeRows({
      columns: 80,
      groundRows: 7,
      streamingThinking: '你'.repeat(80),
      liveTools: [],
    })

    assert.equal(rows.thinkRows, 5) // 2 wrapped display rows + thinking chrome
    assert.equal(rows.totalRows, 12)
  })

  it('counts wrapped tool output by display rows before applying the tool cap', () => {
    const rows = estimateLiveChromeRows({
      columns: 80,
      groundRows: 7,
      streamingThinking: '',
      liveTools: [{ content: '🧪'.repeat(120) }],
    })

    assert.equal(rows.toolRows, 5) // 3 wrapped display rows + tool chrome
    assert.equal(rows.totalRows, 12)
  })

  it('caps each live tool reservation to 12 rows', () => {
    const rows = estimateLiveChromeRows({
      columns: 80,
      groundRows: 7,
      streamingThinking: '',
      liveTools: [{ content: Array.from({ length: 40 }, (_, i) => `line${i}`).join('\n') }],
    })

    assert.equal(rows.toolRows, 12)
    assert.equal(rows.totalRows, 19)
  })
})
