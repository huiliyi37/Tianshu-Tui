import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { evaluateThinkingRetry } from '../thinking-retry.js'

describe('evaluateThinkingRetry', () => {
  it('should not retry when streamedText is non-empty', () => {
    const result = evaluateThinkingRetry({
      streamedText: 'hello',
      collectedBlockCount: 0,
      thinkingAccum: '',
      thinkingOnlyRetries: 0,
      lastThinkingContent: '',
    })
    assert.equal(result.shouldRetry, false)
  })

  it('should not retry when collectedBlockCount > 0', () => {
    const result = evaluateThinkingRetry({
      streamedText: '',
      collectedBlockCount: 1,
      thinkingAccum: 'some reasoning',
      thinkingOnlyRetries: 0,
      lastThinkingContent: '',
    })
    assert.equal(result.shouldRetry, false)
  })

  it('should not retry when thinkingOnlyRetries >= 1', () => {
    const result = evaluateThinkingRetry({
      streamedText: '',
      collectedBlockCount: 0,
      thinkingAccum: 'some reasoning',
      thinkingOnlyRetries: 1,
      lastThinkingContent: '',
    })
    assert.equal(result.shouldRetry, false)
  })

  it('should not retry on completely empty response (no thinking, no text, no blocks)', () => {
    const result = evaluateThinkingRetry({
      streamedText: '',
      collectedBlockCount: 0,
      thinkingAccum: '',
      thinkingOnlyRetries: 0,
      lastThinkingContent: '',
    })
    assert.equal(result.shouldRetry, false)
    assert.equal(result.isLooping, false)
  })

  it('should retry when model produced thinking but no text or blocks', () => {
    const result = evaluateThinkingRetry({
      streamedText: '',
      collectedBlockCount: 0,
      thinkingAccum: 'Let me think about this carefully...',
      thinkingOnlyRetries: 0,
      lastThinkingContent: '',
    })
    assert.equal(result.shouldRetry, true)
    assert.equal(result.nextState.thinkingOnlyRetries, 1)
  })

  it('should detect looping when thinking matches last attempt', () => {
    const sameThinking = 'A'.repeat(700)
    const result = evaluateThinkingRetry({
      streamedText: '',
      collectedBlockCount: 0,
      thinkingAccum: sameThinking,
      thinkingOnlyRetries: 0,
      lastThinkingContent: sameThinking,
    })
    assert.equal(result.shouldRetry, false)
    assert.equal(result.isLooping, true)
  })
})
