import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { shouldInjectPrefix, buildPrefixMessage } from '../prefix-completion.js'

describe('prefix-completion', () => {
  describe('shouldInjectPrefix', () => {
    it('returns true for deepseek provider without tool_choice', () => {
      assert.equal(shouldInjectPrefix({ provider: 'deepseek', hasToolChoice: false, enabled: true }), true)
    })
    it('returns false when tool_choice is set', () => {
      assert.equal(shouldInjectPrefix({ provider: 'deepseek', hasToolChoice: true, enabled: true }), false)
    })
    it('returns false for non-deepseek provider', () => {
      assert.equal(shouldInjectPrefix({ provider: 'mimo', hasToolChoice: false, enabled: true }), false)
    })
    it('returns false when disabled', () => {
      assert.equal(shouldInjectPrefix({ provider: 'deepseek', hasToolChoice: false, enabled: false }), false)
    })
  })
  describe('buildPrefixMessage', () => {
    it('returns assistant message with prefix flag', () => {
      const msg = buildPrefixMessage()
      assert.equal(msg.role, 'assistant')
      assert.equal(msg.prefix, true)
      assert.equal(typeof msg.content, 'string')
    })
  })
})
