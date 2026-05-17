import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { formatDuration, formatThinkingSize } from '../thinking.js'

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
