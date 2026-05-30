import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { formatToolElapsed } from '../tool-elapsed.js'

describe('S4: formatToolElapsed', () => {
  it('returns empty for under 1 second (no noise on fast tools)', () => {
    assert.equal(formatToolElapsed(0), '')
    assert.equal(formatToolElapsed(500), '')
    assert.equal(formatToolElapsed(999), '')
  })
  it('shows whole seconds from 1s', () => {
    assert.equal(formatToolElapsed(1000), '1s')
    assert.equal(formatToolElapsed(1500), '1s')
    assert.equal(formatToolElapsed(4200), '4s')
  })
  it('shows m:ss past a minute', () => {
    assert.equal(formatToolElapsed(60_000), '1m00s')
    assert.equal(formatToolElapsed(65_000), '1m05s')
    assert.equal(formatToolElapsed(125_000), '2m05s')
  })
  it('handles negative input gracefully', () => {
    assert.equal(formatToolElapsed(-100), '')
  })
})
