import { describe, it } from 'node:test'
import { strict as assert } from 'node:assert'
import { compactStaleRoundsOai } from '../stale-round.js'
import type { OaiMessage } from '../../api/oai-types.js'

describe('compactStaleRoundsOai', () => {
  function toolMsg(content: string, toolCallId = 'tc_1'): OaiMessage {
    return { role: 'tool', tool_call_id: toolCallId, content }
  }

  function assistantMsg(text: string): OaiMessage {
    return { role: 'assistant', content: text }
  }

  it('preserves cache anchor messages (first 2) untouched', () => {
    const messages: OaiMessage[] = [
      { role: 'system', content: 'You are helpful' },
      { role: 'user', content: 'hello' },
      assistantMsg('hi'),
      toolMsg('x'.repeat(5000)),
      assistantMsg('done'),
      toolMsg('y'.repeat(5000)),
      assistantMsg('final'),
    ]
    const result = compactStaleRoundsOai(messages, 64_000)
    assert.strictEqual(result[0], messages[0])
    assert.strictEqual(result[1], messages[1])
  })

  it('compacts tool messages in stale rounds (N-2+) to ~1200 chars', () => {
    const messages: OaiMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'anchor1' },
      assistantMsg('anchor2'),
      toolMsg('x'.repeat(5000)),
      assistantMsg('done'),
      toolMsg('y'.repeat(5000)),
      assistantMsg('final'),
      toolMsg('z'.repeat(300)),
      assistantMsg('end'),
    ]
    const result = compactStaleRoundsOai(messages, 64_000)
    // Stale tool messages should be truncated
    const staleMsg = result[3]!
    assert.ok(staleMsg.role === 'tool')
    assert.ok(staleMsg.content.length < 5000)
    assert.ok(staleMsg.content.includes('stale-compacted'))
    // Recent tool messages should be untouched
    const recentMsg = result[7]!
    assert.ok(recentMsg.role === 'tool')
    assert.strictEqual(recentMsg.content.length, 300)
  })

  it('returns same array when no changes needed', () => {
    const messages: OaiMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hello' },
      assistantMsg('hi'),
      toolMsg('x'.repeat(100)),
      assistantMsg('done'),
    ]
    const result = compactStaleRoundsOai(messages, 64_000)
    assert.strictEqual(result, messages) // Same reference
  })

  it('returns same array when too few messages', () => {
    const messages: OaiMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hello' },
    ]
    const result = compactStaleRoundsOai(messages, 64_000)
    assert.strictEqual(result, messages)
  })

  it('preserves non-tool messages untouched', () => {
    const messages: OaiMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'anchor1' },
      assistantMsg('anchor2'),
      { role: 'user', content: 'stale user' },
      assistantMsg('stale asst'),
      assistantMsg('recent asst'),
      toolMsg('z'.repeat(100)),
      assistantMsg('end'),
    ]
    const result = compactStaleRoundsOai(messages, 64_000)
    // User and assistant messages should be untouched
    assert.strictEqual(result[3]!.role, 'user')
    assert.strictEqual(result[4]!.role, 'assistant')
  })

  it('preserves trailing [artifact:X] marker when truncating stale tool messages', () => {
    // Simulates a read_file result: long content followed by an artifact marker.
    // The marker must survive stale-round compaction so the model can call
    // read_section(artifactId=X) to recover the full content.
    const longContent = 'a'.repeat(5000)
    const withMarker = `${longContent}\n[artifact:abc123]`
    const messages: OaiMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'anchor1' },
      assistantMsg('anchor2'),
      toolMsg(withMarker), // stale — should be compacted
      assistantMsg('done'),
      toolMsg('y'.repeat(5000)),
      assistantMsg('final'),
      toolMsg('z'.repeat(300)),
      assistantMsg('end'),
    ]
    const result = compactStaleRoundsOai(messages, 64_000)
    const staleMsg = result[3]!
    assert.ok(staleMsg.role === 'tool')
    assert.ok(staleMsg.content.length < withMarker.length, 'should be truncated')
    assert.match(staleMsg.content, /\[artifact:abc123\]\s*$/, 'marker must be preserved at the tail')
    assert.ok(staleMsg.content.includes('use_read_section_to_retrieve_full_content'), 'compacted hint should reference read_section')
  })

  it('preserves [artifact:X] marker in bash/grep-style output (instructions before marker)', () => {
    // Simulates the new bash/grep output format: content + instructions + [artifact:X] at end.
    // After the format fix, bash and grep place use_read_section text BEFORE the marker.
    const longContent = 'a'.repeat(5000)
    // Bash-style: modelOutput, then instructions, then [artifact:X] at end
    const withMarker = `${longContent}\n\nUse read_section(artifactId="bash123", section="L1-L500") to load full output if the head/tail above is not enough.\n[artifact:bash123]`
    const messages: OaiMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'anchor1' },
      assistantMsg('anchor2'),
      toolMsg(withMarker), // stale — should be compacted
      assistantMsg('done'),
      toolMsg('y'.repeat(5000)),
      assistantMsg('final'),
      toolMsg('z'.repeat(300)),
      assistantMsg('end'),
    ]
    const result = compactStaleRoundsOai(messages, 64_000)
    const staleMsg = result[3]!
    assert.ok(staleMsg.role === 'tool')
    assert.ok(staleMsg.content.length < withMarker.length, 'should be truncated')
    assert.match(staleMsg.content, /\[artifact:bash123\]\s*$/, 'marker must be preserved at the tail even with instructions before it')
    // The original instructions may or may not survive truncation — they are
    // after the long content body. The stale-compacted tag provides the
    // read_section recovery path.
    assert.ok(staleMsg.content.includes('use_read_section_to_retrieve_full_content'), 'stale-compacted tag must provide read_section path')
  })

  it('uses default compaction (no marker recovery) when no [artifact:X] is present', () => {
    const longContent = 'a'.repeat(5000)
    const messages: OaiMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'anchor1' },
      assistantMsg('anchor2'),
      toolMsg(longContent),
      assistantMsg('done'),
      toolMsg('y'.repeat(5000)),
      assistantMsg('final'),
      toolMsg('z'.repeat(300)),
      assistantMsg('end'),
    ]
    const result = compactStaleRoundsOai(messages, 64_000)
    const staleMsg = result[3]!
    assert.ok(staleMsg.role === 'tool')
    assert.ok(staleMsg.content.includes('stale-compacted'))
    assert.ok(!staleMsg.content.includes('[artifact:'), 'no spurious marker should appear')
    assert.ok(!staleMsg.content.includes('use_read_section_to_retrieve_full_content'))
  })

  it('1M context window: keeps 30 recent messages and 30K preview (window-aware)', () => {
    // On a 1M window, the legacy 4-message / 1200-char defaults would prune
    // a single read_file's content after just a few turns. The window-aware
    // thresholds keep 30 recent messages intact and only truncate over 30K.
    const longContent = 'a'.repeat(20_000)  // under 30K threshold
    const messages: OaiMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'user' },
      // 8 stale rounds (16 messages: assistant + tool each)
      ...Array.from({ length: 8 }, () => [
        assistantMsg('a'),
        toolMsg(longContent),
      ]).flat(),
      // 6 recent rounds (12 messages, well under 30 protected)
      ...Array.from({ length: 6 }, (_, i) => [
        assistantMsg(`recent${i}`),
        toolMsg(`r${i}`),
      ]).flat(),
    ]
    // Total: 2 + 16 + 12 = 30 messages. recentToKeep=30 means EVERYTHING is protected.
    const result = compactStaleRoundsOai(messages, 1_000_000)
    // No truncation should happen — message identity preserved.
    assert.equal(result, messages, 'within-protect should be a no-op')
  })

  it('1M context window: only truncates content over 30K, not 1200', () => {
    // A 25K tool_result on a 1M window must stay intact — under previewChars
    // threshold. Only when content exceeds 30K and falls outside the recent
    // 30 messages does it get truncated.
    const messages: OaiMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'user' },
      // Stale section (idx 2)
      assistantMsg('stale-asst'),
      toolMsg('a'.repeat(25_000)),  // 25K, under 30K threshold → must NOT be truncated
      // Pad to push idx 3 into stale region (need >32 messages for 30 recent + 2 anchor)
      ...Array.from({ length: 30 }, (_, i) => [assistantMsg(`a${i}`), toolMsg(`r${i}`)]).flat(),
    ]
    const result = compactStaleRoundsOai(messages, 1_000_000)
    const staleMsg = result[3]!
    assert.ok(staleMsg.role === 'tool')
    assert.equal(staleMsg.content.length, 25_000, '25K content must not be truncated under 30K threshold')
    assert.ok(!staleMsg.content.includes('stale-compacted'))
  })
})
