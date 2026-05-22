import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createContextLedger } from '../ledger.js'
import type { OaiUserMessage, OaiAssistantMessage } from '../../api/oai-types.js'

function userText(content: string): OaiUserMessage {
  return { role: 'user', content }
}

function assistantText(content: string): OaiAssistantMessage {
  return { role: 'assistant', content }
}

describe('createContextLedger', () => {
  it('creates a ledger with round data and token budget', () => {
    const messages = [
      userText('Hello'),
      assistantText('Hi!'),
    ]
    const ledger = createContextLedger('session_1', '/tmp/test.jsonl', messages, 1_000_000)

    assert.equal(ledger.sessionId, 'session_1')
    assert.equal(ledger.rounds.length, 2)
    assert.ok(ledger.tokenBudget.estimatedTokens > 0)
    assert.equal(ledger.tokenBudget.maxTokens, 1_000_000)
    assert.equal(ledger.apiInvariantStatus.okRounds, 2)
  })

  it('reports healthy for small sessions', () => {
    const messages = [
      userText('Hi'),
      assistantText('Hello'),
    ]
    const ledger = createContextLedger('s', '/t', messages, 1_000_000)

    assert.equal(ledger.tokenBudget.compactionState, 'healthy')
  })

  it('reports critical when near context limit', () => {
    const bigText = 'x'.repeat(400_000)
    const messages = [
      userText(bigText),
      assistantText(bigText),
    ]
    const ledger = createContextLedger('s', '/t', messages, 100_000)

    assert.equal(ledger.tokenBudget.compactionState, 'critical')
  })
})
