import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { shouldCapReasoning, DEFAULT_REASONING_CHAIN_CAP_TOKENS } from '../reasoning-chain-guard.js'

describe('shouldCapReasoning (P2 96K reasoning-chain guard)', () => {
  it('does not cap a short chain', () => {
    assert.equal(shouldCapReasoning(100, 1000), false)
  })

  it('caps once accumulated chars/4 reaches the token cap', () => {
    assert.equal(shouldCapReasoning(4000, 1000), true)
    assert.equal(shouldCapReasoning(3999, 1000), false)
  })

  it('cap <= 0 disables the check entirely, regardless of length', () => {
    assert.equal(shouldCapReasoning(10_000_000, 0), false)
    assert.equal(shouldCapReasoning(10_000_000, -1), false)
  })

  it('defaults to 96,000 tokens when capTokens is omitted', () => {
    assert.equal(shouldCapReasoning(DEFAULT_REASONING_CHAIN_CAP_TOKENS * 4 - 1), false)
    assert.equal(shouldCapReasoning(DEFAULT_REASONING_CHAIN_CAP_TOKENS * 4), true)
  })
})
