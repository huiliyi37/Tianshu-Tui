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
})
