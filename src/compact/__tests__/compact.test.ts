import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { microCompact, estimateTokens } from '../micro.js'
import { shouldAutoCompact, buildSummaryPrompt } from '../auto.js'
import type { CompactionConfig } from '../constants.js'

function msg(role: 'user' | 'assistant', content: string) {
  return { role, content }
}

describe('estimateTokens', () => {
  it('estimates tokens (~4 chars per token)', () => {
    assert.equal(estimateTokens([msg('user', 'hello world')]), 3)  // 11/4 = 3
    assert.equal(estimateTokens([msg('user', '')]), 0)
  })

  it('handles multiple messages', () => {
    const messages = [
      msg('user', 'hello world'),
      msg('assistant', 'hi there'),
    ]
    // 11/4=3 + 8/4=2 = 5
    assert.equal(estimateTokens(messages), 5)
  })
})

describe('microCompact', () => {
  it('returns messages unchanged when under context window', () => {
    const messages = [msg('user', 'a'), msg('assistant', 'b')]
    const result = microCompact(messages, 1_000_000, 10)
    assert.equal(result.truncated, 0)
    assert.equal(result.messages.length, 2)
  })

  it('truncates old messages iteratively to fit context window', () => {
    // Each message ~25 tokens (100/4=25). Total 200 tokens. Context window = 60 tokens.
    // estimateTokens recomputes: 200 tokens > 60 → truncates until ≤ 60 tokens.
    // 4 messages × 25 = 100 tokens still > 60 → only keeps last 4 (the floor).
    const bigMsg = 'x'.repeat(100)
    const messages = [
      msg('user', bigMsg), msg('assistant', bigMsg),
      msg('user', bigMsg), msg('assistant', bigMsg),
      msg('user', bigMsg), msg('assistant', bigMsg),
      msg('user', bigMsg), msg('assistant', bigMsg),
    ]
    const result = microCompact(messages, 60, 500)
    assert.ok(result.truncated >= 4, `expected >= 4 truncated, got ${result.truncated}`)
    assert.equal(result.messages.length, 4) // hits KEEP_RECENT_MESSAGES floor
  })

  it('does not truncate when too few messages', () => {
    const messages = [msg('user', '1'), msg('assistant', '2')]
    const result = microCompact(messages, 50, 500)
    assert.equal(result.truncated, 0)
    assert.equal(result.messages.length, 2)
  })
})

describe('shouldAutoCompact', () => {
  const config: CompactionConfig = {
    enabled: true,
    autoThreshold: 800_000,
    autoFloor: 500_000,
    model: 'deepseek-v4-flash',
  }

  it('returns disabled when compaction is off', () => {
    const decision = shouldAutoCompact([], { ...config, enabled: false })
    assert.equal(decision.shouldCompact, false)
    assert.equal(decision.reason, 'disabled')
  })

  it('returns below_floor when under 500K tokens', () => {
    const messages = [msg('user', 'hello'), msg('assistant', 'hi')]
    const decision = shouldAutoCompact(messages, config)
    assert.equal(decision.shouldCompact, false)
    assert.equal(decision.reason, 'below_floor')
  })

  it('returns below_threshold when between floor and threshold', () => {
    // ~750K tokens → above floor (500K) but below threshold (800K)
    const bigMsg = 'x'.repeat(250_000 * 4) // ~250K tokens per msg
    const messages = [msg('user', bigMsg), msg('assistant', bigMsg), msg('user', bigMsg)]
    const decision = shouldAutoCompact(messages, config)
    assert.equal(decision.shouldCompact, false)
    assert.equal(decision.reason, 'below_threshold')
  })

  it('returns not_enough_messages when under 6 messages', () => {
    // Each msg ~250K tokens → total 1M → above threshold (800K). But only 4 msgs < 6
    const bigMsg = 'x'.repeat(250_000 * 4)
    const messages = [
      msg('user', bigMsg), msg('assistant', bigMsg),
      msg('user', bigMsg), msg('assistant', bigMsg),
    ]
    const decision = shouldAutoCompact(messages, config)
    assert.equal(decision.shouldCompact, false)
    assert.equal(decision.reason, 'not_enough_messages')
  })

  it('triggers compaction when all conditions met', () => {
    // 6 messages, each ~200K tokens → total 1.2M tokens → above threshold
    const bigMsg = 'x'.repeat(200_000 * 4)
    const messages = [
      msg('user', bigMsg), msg('assistant', bigMsg),
      msg('user', bigMsg), msg('assistant', bigMsg),
      msg('user', bigMsg), msg('assistant', bigMsg),
    ]
    const decision = shouldAutoCompact(messages, config)
    assert.equal(decision.shouldCompact, true)
    assert.equal(decision.reason, 'triggered')
    assert.ok(decision.tokenCount > config.autoThreshold)
  })
})

describe('buildSummaryPrompt', () => {
  it('builds a structured summary prompt from messages', () => {
    const messages = [
      msg('user', 'Fix the login bug'),
      msg('assistant', 'I found the issue in auth.ts'),
      msg('user', 'Great, please fix it'),
    ]
    const prompt = buildSummaryPrompt(messages, 100_000)
    assert.ok(prompt.includes('Summarize the following conversation'))
    assert.ok(prompt.includes('Fix the login bug'))
    assert.ok(prompt.includes('auth.ts'))
    assert.ok(prompt.includes('500 words')) // standard mode
  })

  it('uses large context limits when token count > 500K', () => {
    const messages = [
      msg('user', 'x'.repeat(1000)),
      msg('assistant', 'y'),
    ]
    const prompt = buildSummaryPrompt(messages, 600_000)
    assert.ok(prompt.includes('900 words'))
  })

  it('truncates very long conversation history', () => {
    const longMsg = 'a'.repeat(50_000)
    const messages = [
      msg('user', longMsg),
      msg('assistant', longMsg),
    ]
    const prompt = buildSummaryPrompt(messages, 50_000)
    // Should be under SUMMARY_INPUT_MAX_CHARS (24K) + instruction overhead
    assert.ok(prompt.length < 30_000)
  })
})
