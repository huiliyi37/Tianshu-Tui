import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { Message } from '../../api/types.js'
import { createCompactBoundaryMessage, selectReactiveCompactRounds } from '../reactive-compact.js'

describe('reactive compact', () => {
  it('selects middle safe rounds while preserving anchor and recent messages', () => {
    const messages: Message[] = [
      { role: 'user', content: 'anchor' },
      { role: 'assistant', content: 'anchor answer' },
      { role: 'user', content: 'old work' },
      { role: 'assistant', content: 'old answer' },
      { role: 'user', content: 'recent' },
      { role: 'assistant', content: 'recent answer' },
    ]

    const selected = selectReactiveCompactRounds(messages, { anchorMessages: 2, recentMessages: 2 })
    assert.equal(selected.length, 2) // old work + old answer rounds
  })

  it('creates a compact boundary message with source range metadata', () => {
    const message = createCompactBoundaryMessage({
      startIndex: 2,
      endIndex: 5,
      summary: 'User inspected test failures and fixed the parser.',
      tokenBefore: 4000,
      tokenAfter: 200,
    })

    assert.equal(message.role, 'user')
    assert.match(String(message.content), /<compact-summary/)
    assert.match(String(message.content), /source_start="2"/)
    assert.match(String(message.content), /token_before="4000"/)
  })
})
