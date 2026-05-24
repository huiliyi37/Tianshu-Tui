import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { pruneStaleToolResults } from '../prune.js'
import type { OaiMessage } from '../../api/oai-types.js'

function toolMsg(content: string): OaiMessage {
  return { role: 'tool', content, tool_call_id: `call_${Math.random().toString(36).slice(2)}` }
}
function userMsg(content: string): OaiMessage { return { role: 'user', content } }
function assistantMsg(content: string): OaiMessage { return { role: 'assistant', content } }

describe('pruneStaleToolResults', () => {
  it('preserves recent tool results within protect window', () => {
    const messages: OaiMessage[] = [
      userMsg('system'), assistantMsg('anchor'),
      userMsg('q1'), assistantMsg('a1'), toolMsg('recent-output-1'),
      userMsg('q2'), assistantMsg('a2'), toolMsg('recent-output-2'),
    ]
    const result = pruneStaleToolResults(messages, { protectRecentMessages: 6 })
    assert.equal(result.prunedCount, 0)
    assert.deepEqual(result.messages, messages)
  })

  it('clears stale tool results beyond protect window', () => {
    const longContent = 'x'.repeat(5000)
    const messages: OaiMessage[] = [
      userMsg('system'), assistantMsg('anchor'),          // 0,1 anchors
      userMsg('old-q'), assistantMsg('old-a'), toolMsg(longContent),   // 2,3,4 stale
      userMsg('old-q2'), assistantMsg('old-a2'), toolMsg(longContent), // 5,6,7 stale
      userMsg('recent-q'), assistantMsg('recent-a'), toolMsg('short-recent'), // 8,9,10
      userMsg('latest'), assistantMsg('latest-a'), toolMsg('latest'),  // 11,12,13
    ]
    // 14 messages, protectRecentMessages=6 → recentStart=8. idx 4,7 are stale.
    const result = pruneStaleToolResults(messages, { protectRecentMessages: 6 })
    assert.equal(result.prunedCount, 2)
    assert.ok((result.messages[4] as OaiMessage & { content: string }).content.includes('[pruned:'))
    assert.ok((result.messages[7] as OaiMessage & { content: string }).content.includes('[pruned:'))
    assert.equal((result.messages[10] as OaiMessage & { content: string }).content, 'short-recent')
  })

  it('skips tool results already pruned or short', () => {
    const messages: OaiMessage[] = [
      userMsg('system'), assistantMsg('anchor'),
      userMsg('q'), assistantMsg('a'), toolMsg('short'),
      userMsg('q2'), assistantMsg('a2'), toolMsg('also-short'),
      userMsg('recent'), assistantMsg('recent-a'), toolMsg('recent'),
    ]
    const result = pruneStaleToolResults(messages, { protectRecentMessages: 4 })
    assert.equal(result.prunedCount, 0)
  })

  it('never touches cache anchor messages', () => {
    const longContent = 'x'.repeat(5000)
    const messages: OaiMessage[] = [
      userMsg(longContent), assistantMsg(longContent),
      userMsg('q'), assistantMsg('a'), toolMsg(longContent),
      userMsg('recent'), assistantMsg('recent-a'), toolMsg('r'),
    ]
    const result = pruneStaleToolResults(messages, { protectRecentMessages: 4 })
    assert.equal((result.messages[0] as OaiMessage & { content: string }).content, longContent)
    assert.equal((result.messages[1] as OaiMessage & { content: string }).content, longContent)
  })

  it('respects minimum content threshold', () => {
    const messages: OaiMessage[] = [
      userMsg('system'), assistantMsg('anchor'),
      userMsg('q'), assistantMsg('a'), toolMsg('x'.repeat(800)),
      userMsg('recent'), assistantMsg('recent-a'), toolMsg('r'),
    ]
    const result = pruneStaleToolResults(messages, { protectRecentMessages: 4 })
    assert.equal(result.prunedCount, 0)
  })

  it('returns freed chars for token estimate adjustment', () => {
    const longContent = 'x'.repeat(10_000)
    const messages: OaiMessage[] = [
      userMsg('system'), assistantMsg('anchor'),                       // 0,1
      userMsg('q1'), assistantMsg('a1'), toolMsg(longContent),         // 2,3,4
      userMsg('q2'), assistantMsg('a2'), toolMsg(longContent),         // 5,6,7
      userMsg('q3'), assistantMsg('a3'), toolMsg(longContent),         // 8,9,10
      userMsg('recent'), assistantMsg('recent-a'), toolMsg('r'),       // 11,12,13
      userMsg('latest'), assistantMsg('latest-a'), toolMsg('latest'),  // 14,15,16
    ]
    // 17 messages, protectRecentMessages=6 → recentStart=11. idx 4,7,10 are stale.
    const result = pruneStaleToolResults(messages, { protectRecentMessages: 6 })
    assert.equal(result.prunedCount, 3)
    assert.equal(result.freedChars, 30_000)
  })

  it('preserves trailing [artifact:X] marker so read_section can recover content', () => {
    const longContent = 'a'.repeat(10_000)
    const withMarker = `${longContent}\n[artifact:abc123]`
    const messages: OaiMessage[] = [
      userMsg('system'), assistantMsg('anchor'),
      userMsg('q1'), assistantMsg('a1'), toolMsg(withMarker),
      userMsg('r1'), assistantMsg('r1a'), toolMsg('x'),
      userMsg('r2'), assistantMsg('r2a'), toolMsg('x'),
      userMsg('r3'), assistantMsg('r3a'), toolMsg('x'),
    ]
    const result = pruneStaleToolResults(messages, { protectRecentMessages: 8 })
    assert.equal(result.prunedCount, 1)
    const pruned = result.messages[4]!
    assert.ok(pruned.role === 'tool')
    assert.match(pruned.content, /\[artifact:abc123\]\s*$/, 'marker must survive prune at the tail')
    assert.ok(pruned.content.includes('use read_section'), 'should hint at read_section recovery')
    assert.ok(pruned.content.startsWith('[pruned:'), 'still starts with [pruned: idempotency marker')
  })

  it('1M context window: protects 60 recent messages and skips content under 30K', () => {
    // Regression: before window-aware thresholds, a 1M context with 12+ messages
    // pruned all stale tool_results to ~50-char placeholders, deleting up to
    // 60K of read_file content per call and triggering "split temp files"
    // workarounds in the model.
    const content60K = 'a'.repeat(60_000)
    const messages: OaiMessage[] = [
      userMsg('system'), assistantMsg('anchor'),
      // 4 turns of read_file results, each 60K — would be pruned with legacy 8/1200
      assistantMsg('a1'), toolMsg(content60K),
      assistantMsg('a2'), toolMsg(content60K),
      assistantMsg('a3'), toolMsg(content60K),
      assistantMsg('a4'), toolMsg(content60K),
      // 8 more turns, all small tool_results
      ...Array.from({ length: 8 }, (_, i) => [
        assistantMsg(`a${i}`), toolMsg('r'),
      ]).flat(),
    ]
    // 26 messages total — under window-aware protectRecent=60, so nothing prunes.
    const result = pruneStaleToolResults(messages, { contextWindow: 1_000_000 })
    assert.equal(result.prunedCount, 0, '1M window must not prune within 60 recent messages')
  })

  it('1M context window: still prunes when truly stale (66+ messages)', () => {
    // If we *do* exceed 60 protected + 2 anchor = 62, the oldest tool_results
    // beyond protection should still be pruned, but only when above 150K
    // (artifact wrap threshold — content below this size is never wrapped, so
    // there's no artifact backup to recover it from, so prune leaves it alone).
    const content200K = 'a'.repeat(200_000)
    const messages: OaiMessage[] = [
      userMsg('system'), assistantMsg('anchor'),
      assistantMsg('old'), toolMsg(content200K),  // idx 3 — should be pruned
      // 70 padding messages to push idx 3 into the stale region
      ...Array.from({ length: 70 }, () => assistantMsg('pad')),
    ]
    const result = pruneStaleToolResults(messages, { contextWindow: 1_000_000 })
    assert.equal(result.prunedCount, 1, 'truly stale 200K tool_result should be pruned even on 1M')
  })

  it('legacy small window (<200K) keeps the original 8-message / 1200-char behavior', () => {
    const messages: OaiMessage[] = [
      userMsg('system'), assistantMsg('anchor'),
      assistantMsg('a1'), toolMsg('x'.repeat(2000)),  // pruneable: > 1200
      ...Array.from({ length: 10 }, () => assistantMsg('pad')),
    ]
    const result = pruneStaleToolResults(messages, { contextWindow: 64_000 })
    assert.equal(result.prunedCount, 1, 'legacy window must still prune > 1200 char content')
  })
})
