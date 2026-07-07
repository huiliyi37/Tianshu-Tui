import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { detectOrphanToolCallsOai, runResumePreflightOai } from '../../context/resume-preflight.js'
import type { OaiMessage } from '../../api/oai-types.js'

/**
 * Regression test for mqnzf25uu6dq907j session crash.
 *
 * Bug: tryPartialCompact constructs newMessages = [...anchor, summary, ...recentZone].
 * If anchor contains assistant(tool_calls) whose results were in oldZone (deleted),
 * the tool_call becomes orphaned → API rejects with:
 *   "An assistant message with 'tool_calls' must be followed by tool messages
 *    responding to each 'tool_call_id'"
 *
 * Fix: safeReplaceMessages runs runResumePreflightOai before replaceMessages,
 * inserting synthetic tool results for any orphaned tool_calls.
 */
describe('regression: partial compact orphan tool_call (mqnzf25u)', () => {
  function makeToolCall(id: string, name: string): OaiMessage {
    return {
      role: 'assistant',
      content: null,
      tool_calls: [{ id, type: 'function', function: { name, arguments: '{}' } }],
    } as OaiMessage
  }
  function makeToolResult(id: string): OaiMessage {
    return { role: 'tool', tool_call_id: id, content: 'result' } as OaiMessage
  }

  it('detects orphan tool_call left in anchor after oldZone deletion', () => {
    // Simulate post-compact newMessages (anchor[1] = orphaned tool_call)
    const newMessages: OaiMessage[] = [
      { role: 'user', content: '查看最近的桌面端提交' },
      makeToolCall('call_zEnj', 'git'),       // orphan — result was deleted with oldZone
      { role: 'assistant', content: '<partial-compact-summary>...</partial-compact-summary>' },
      makeToolCall('call_grep', 'grep'),
      makeToolResult('call_grep'),
      { role: 'assistant', content: 'done' },
    ]

    const orphans = detectOrphanToolCallsOai(newMessages)
    assert.equal(orphans.length, 1)
    assert.equal(orphans[0], 'call_zEnj')
  })

  it('runResumePreflightOai inserts synthetic result for orphaned anchor tool_call', () => {
    const newMessages: OaiMessage[] = [
      { role: 'user', content: 'hello' },
      makeToolCall('call_A', 'bash'),         // orphan
      { role: 'assistant', content: '<partial-compact-summary>...</partial-compact-summary>' },
      makeToolCall('call_B', 'grep'),
      makeToolResult('call_B'),
    ]

    const report = runResumePreflightOai(newMessages)
    assert.equal(report.repaired, true)
    assert.equal(report.syntheticResultsInserted, 1)
    assert.equal(report.safe, true)

    // Synthetic result must exist for call_A
    const synthetic = report.messages.find(
      m => m.role === 'tool' && 'tool_call_id' in m && m.tool_call_id === 'call_A',
    )
    assert.ok(synthetic, 'synthetic tool result for call_A must exist')
  })

  it('runResumePreflightOai is a no-op when no orphans exist', () => {
    const messages: OaiMessage[] = [
      { role: 'user', content: 'hello' },
      makeToolCall('call_A', 'bash'),
      makeToolResult('call_A'),
      { role: 'assistant', content: 'done' },
    ]

    const report = runResumePreflightOai(messages)
    assert.equal(report.repaired, false)
    assert.equal(report.syntheticResultsInserted, 0)
    assert.equal(report.safe, true)
  })
})
