import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { OpenAIClient, type OpenAIClientConfig } from '../openai-client.js'

const TEST_CONFIG: OpenAIClientConfig = {
  baseUrl: 'https://api.openai.com/v1',
  apiKey: 'sk-test',
  model: 'gpt-4o',
  maxTokens: 4096,
}

/** Access the private probe directly — stream() would require a network mock,
 *  and the probe's contract is purely about the fingerprint comparison. */
function record(client: OpenAIClient, messages: Array<Record<string, unknown>>): void {
  (client as unknown as { recordWireDivergence(m: Array<Record<string, unknown>>): void })
    .recordWireDivergence(messages)
}

describe('wire-level prefix divergence probe', () => {
  const sys = { role: 'system', content: 'you are helpful' }
  const u1 = { role: 'user', content: 'hello' }
  const a1 = { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{}' } }] }
  const t1 = { role: 'tool', tool_call_id: 'c1', content: 'file body' }

  it('first request records a baseline, no divergence', () => {
    const client = new OpenAIClient(TEST_CONFIG)
    record(client, [sys, u1])
    assert.equal(client.consumeWireDivergence(), null)
  })

  it('pure append records nothing', () => {
    const client = new OpenAIClient(TEST_CONFIG)
    record(client, [sys, u1])
    record(client, [sys, u1, a1, t1])
    assert.equal(client.consumeWireDivergence(), null)
  })

  it('mid-history byte change records the diverged index and role', () => {
    const client = new OpenAIClient(TEST_CONFIG)
    record(client, [sys, u1, a1, t1])
    // Same shape, but the assistant message gained a reasoning_content field —
    // exactly the class of send-layer churn the engine probe cannot see.
    const a1Mutated = { ...a1, reasoning_content: 'thought about it' }
    record(client, [sys, u1, a1Mutated, t1, { role: 'user', content: 'next' }])
    const d = client.consumeWireDivergence()
    assert.ok(d)
    assert.equal(d!.idx, 2)
    assert.equal(d!.role, 'assistant')
    assert.equal(d!.kind, 'message_changed')
    // consume-once semantics
    assert.equal(client.consumeWireDivergence(), null)
  })

  it('history shrink records message_removed at the cut point', () => {
    const client = new OpenAIClient(TEST_CONFIG)
    record(client, [sys, u1, a1, t1])
    record(client, [sys, u1])
    const d = client.consumeWireDivergence()
    assert.ok(d)
    assert.equal(d!.idx, 2)
    assert.equal(d!.kind, 'message_removed')
    assert.equal(d!.prevCount, 4)
    assert.equal(d!.newCount, 2)
  })

  it('approxCharPos accumulates serialized lengths of the shared prefix', () => {
    const client = new OpenAIClient(TEST_CONFIG)
    record(client, [sys, u1, t1])
    const t1Mutated = { ...t1, content: 'file body CHANGED' }
    record(client, [sys, u1, t1Mutated])
    const d = client.consumeWireDivergence()
    assert.ok(d)
    assert.equal(d!.idx, 2)
    assert.equal(d!.approxCharPos, JSON.stringify(sys).length + JSON.stringify(u1).length)
  })
})
