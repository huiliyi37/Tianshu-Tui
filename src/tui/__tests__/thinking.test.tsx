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
  it('shows plain duration under 30s', () => {
    assert.equal(thinkingStatusLabel({ isStreaming: true, elapsedMs: 12_000 }), '12s')
  })

  it('shows Collecting context at 30s+', () => {
    assert.equal(thinkingStatusLabel({ isStreaming: true, elapsedMs: 42_000 }), 'Collecting context... 42s')
  })

  it('shows Still thinking at 90s+', () => {
    assert.equal(thinkingStatusLabel({ isStreaming: true, elapsedMs: 95_000 }), 'Still thinking... 1m 35s')
  })

  it('shows Long think at 180s+', () => {
    assert.equal(thinkingStatusLabel({ isStreaming: true, elapsedMs: 190_000 }), 'Long think — Ctrl+C to stop (3m)')
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
