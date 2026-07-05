import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { OaiMessage } from '../../api/oai-types.js'
import { compactStaleRoundsOai } from '../stale-round.js'
import { microCompactOai } from '../micro.js'
import { applyAgentDiet } from '../agent-diet.js'

/**
 * prefix-cache audit 4.2 — frozen user message immutability invariant.
 *
 * The five compaction functions in src/compact/ must NEVER modify user message
 * content. The engine's frozenUserMerged map keys on user message text; if any
 * compaction layer mutates that text, the frozen snapshot becomes stale and the
 * exact-prefix cache breaks for every subsequent turn.
 *
 * This test is the regression nail: it feeds each compaction function a message
 * array with known user content, runs the compaction, and asserts that every
 * user message in the output is byte-identical to the input.
 */

function makeMessages(toolResultSize: number): OaiMessage[] {
  return [
    { role: 'user', content: 'ORIGINAL_USER_0' },
    { role: 'assistant', content: 'resp0', tool_calls: [{ id: 'tool_0', type: 'function', function: { name: 'read_file', arguments: '{"file_path":"a.ts"}' } }] },
    { role: 'tool', content: 'x'.repeat(toolResultSize), tool_call_id: 'tool_0' },
    { role: 'user', content: 'ORIGINAL_USER_1' },
    { role: 'assistant', content: 'resp1', tool_calls: [{ id: 'tool_1', type: 'function', function: { name: 'grep', arguments: '{"pattern":"x","path":"."}' } }] },
    { role: 'tool', content: 'y'.repeat(toolResultSize), tool_call_id: 'tool_1' },
    { role: 'user', content: 'LATEST_USER' },
  ] as OaiMessage[]
}

function assertUserMessagesUnchanged(input: OaiMessage[], output: OaiMessage[]): void {
  const inputUsers = input.filter(m => m.role === 'user')
  const outputUsers = output.filter(m => m.role === 'user')
  for (let i = 0; i < Math.min(inputUsers.length, outputUsers.length); i++) {
    assert.equal(
      outputUsers[i]!.content,
      inputUsers[i]!.content,
      `user message ${i} content must be byte-identical after compaction`,
    )
  }
}

describe('prefix-cache audit 4.2: frozen user message immutability', () => {
  it('compactStaleRoundsOai never mutates user message content', () => {
    const msgs = makeMessages(10_000)
    const result = compactStaleRoundsOai(msgs, 200_000)
    assertUserMessagesUnchanged(msgs, result)
  })

  it('microCompactOai never mutates user message content', () => {
    const msgs = makeMessages(10_000)
    const result = microCompactOai(msgs, 200_000, 50_000)
    assertUserMessagesUnchanged(msgs, result.messages)
  })

  it('applyAgentDiet never mutates user message content', () => {
    const msgs = makeMessages(5_000)
    const result = applyAgentDiet(msgs, { protectRecentMessages: 2 })
    assertUserMessagesUnchanged(msgs, result.messages)
  })

  it('microCompactOai Tier 2 (round removal) preserves surviving user messages', () => {
    // Large messages that force Tier 2 round removal.
    const msgs: OaiMessage[] = [
      { role: 'user', content: 'KEEP_ME_0' },
      { role: 'assistant', content: 'a'.repeat(100_000), tool_calls: [{ id: 'tc0', type: 'function', function: { name: 'read_file', arguments: '{}' } }] },
      { role: 'tool', content: 't'.repeat(100_000), tool_call_id: 'tc0' },
      { role: 'user', content: 'KEEP_ME_1' },
      { role: 'assistant', content: 'b'.repeat(100_000), tool_calls: [{ id: 'tc1', type: 'function', function: { name: 'read_file', arguments: '{}' } }] },
      { role: 'tool', content: 'u'.repeat(100_000), tool_call_id: 'tc1' },
      { role: 'user', content: 'LATEST' },
    ] as OaiMessage[]
    const result = microCompactOai(msgs, 50_000, 500_000)
    // Whatever rounds were removed, surviving user messages must be unchanged.
    for (const u of result.messages.filter(m => m.role === 'user')) {
      assert.ok(
        ['KEEP_ME_0', 'KEEP_ME_1', 'LATEST'].includes(typeof u.content === 'string' ? u.content : ''),
        `surviving user message "${u.content}" was not in the original set — content was mutated`,
      )
    }
  })
})
