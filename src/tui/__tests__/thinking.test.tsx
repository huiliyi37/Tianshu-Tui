import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { formatDuration, formatThinkingSize, thinkingStatusLabel } from '../thinking.js'

describe('thinking helpers', () => {
  it('formats elapsed thinking duration', () => {
    assert.equal(formatDuration(0), '0s')
    assert.equal(formatDuration(59_000), '59s')
    assert.equal(formatDuration(61_000), '1m 1s')
  })

  it('formats thinking size', () => {
    assert.equal(formatThinkingSize(999), '999 chars')
    assert.equal(formatThinkingSize(1500), '1.5k')
  })
})

describe('thinking status label', () => {
  it('keeps active thinking duration concise', () => {
    assert.equal(thinkingStatusLabel({ isStreaming: true, elapsedMs: 42_000 }), '42s')
  })

  it('shows final thinking duration after completion', () => {
    assert.equal(
      thinkingStatusLabel({ isStreaming: false, elapsedMs: 0, completedDurationMs: 128_000 }),
      'completed in 2m 8s',
    )
  })

  it('falls back to completed when no final duration is available', () => {
    assert.equal(thinkingStatusLabel({ isStreaming: false, elapsedMs: 0 }), 'completed')
  })
})
