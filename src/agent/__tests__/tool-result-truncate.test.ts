import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { truncateToolResult } from '../tool-result-truncate.js'

describe('truncateToolResult', () => {
  it('returns content unchanged when under budget', () => {
    const short = 'hello world'
    assert.equal(truncateToolResult(short, 100_000), short)
  })

  it('truncates oversized content with marker', () => {
    const long = 'x'.repeat(500_000)
    const result = truncateToolResult(long, 1_000)

    assert.ok(result.length < long.length)
    assert.match(result, /\.\.\.\[truncated \d+ chars\]\.\.\./)
  })

  it('preserves head and tail and appends truncation warning', () => {
    const content = 'HEAD_MARKER' + 'x'.repeat(500_000) + 'TAIL_MARKER'
    const result = truncateToolResult(content, 1_000)

    assert.ok(result.startsWith('HEAD_MARKER'))
    assert.ok(result.includes('TAIL_MARKER'))
    assert.ok(result.includes('[WARNING: this result was truncated'))
    assert.ok(result.includes('Do not draw architectural conclusions'))
  })

  it('handles empty content', () => {
    assert.equal(truncateToolResult('', 100_000), '')
  })
})
