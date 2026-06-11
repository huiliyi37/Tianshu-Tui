import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { requestTimeCollapse, computeCollapseBoundary } from '../engine.js'
import type { OaiMessage } from '../../api/oai-types.js'

function makeToolResult(toolCallId: string, content: string): OaiMessage {
  return { role: 'tool', tool_call_id: toolCallId, content }
}

function makeAssistantWithToolCall(callId: string, fnName: string): OaiMessage {
  return {
    role: 'assistant',
    content: '',
    tool_calls: [{ id: callId, type: 'function', function: { name: fnName, arguments: '{}' } }],
  }
}

function makeUser(content: string): OaiMessage {
  return { role: 'user', content }
}

describe('computeCollapseBoundary', () => {
  it('returns 0 when no message is old enough', () => {
    const messages: OaiMessage[] = [
      makeUser('task 1'),
      makeAssistantWithToolCall('c1', 'grep'),
      makeToolResult('c1', 'x'.repeat(500)),
      makeUser('task 2'),
    ]
    assert.equal(computeCollapseBoundary(messages, 4), 0)
  })

  it('covers messages whose turn age >= collapseAge', () => {
    const messages: OaiMessage[] = [
      makeUser('turn 1'),                       // idx 0, age 5
      makeAssistantWithToolCall('c1', 'grep'),  // idx 1, age 5
      makeToolResult('c1', 'x'.repeat(500)),    // idx 2, age 5
      makeUser('turn 2'),                       // idx 3, age 4
      makeUser('turn 3'),                       // idx 4, age 3
      makeUser('turn 4'),
      makeUser('turn 5'),
      makeUser('turn 6'),
    ]
    // age >= 4 holds through idx 3 (turn 2, age 4) → boundary 4
    assert.equal(computeCollapseBoundary(messages, 4), 4)
  })
})

describe('requestTimeCollapse', () => {
  it('does not collapse recent tool results (below-boundary only)', () => {
    const messages: OaiMessage[] = [
      makeUser('task 1'),
      makeAssistantWithToolCall('c1', 'grep'),
      makeToolResult('c1', 'x'.repeat(500)),
      makeUser('task 2'),
    ]
    const original = messages[2]!.content
    requestTimeCollapse(messages, computeCollapseBoundary(messages, 4), 1_000_000)
    assert.equal(messages[2]!.content, original)
  })

  it('collapses old tool results below the boundary', () => {
    const messages: OaiMessage[] = [
      makeUser('turn 1'),
      makeAssistantWithToolCall('c1', 'grep'),
      makeToolResult('c1', Array.from({ length: 50 }, (_, i) => `src/file${i}.ts:10: match`).join('\n')),
      makeUser('turn 2'),
      makeUser('turn 3'),
      makeUser('turn 4'),
      makeUser('turn 5'),
      makeUser('turn 6'),
    ]
    const originalLen = (messages[2]! as { content: string }).content.length
    requestTimeCollapse(messages, computeCollapseBoundary(messages, 4), 1_000_000)
    const collapsed = (messages[2]! as { content: string }).content
    assert.ok(collapsed.length < originalLen)
    assert.ok(collapsed.startsWith('[collapsed grep:'))
  })

  it('skips already-collapsed results', () => {
    const messages: OaiMessage[] = [
      makeUser('turn 1'),
      makeAssistantWithToolCall('c1', 'grep'),
      makeToolResult('c1', '[collapsed grep: already done]'),
      makeUser('turn 2'),
      makeUser('turn 3'),
      makeUser('turn 4'),
      makeUser('turn 5'),
      makeUser('turn 6'),
    ]
    requestTimeCollapse(messages, computeCollapseBoundary(messages, 4), 1_000_000)
    assert.equal(messages[2]!.content, '[collapsed grep: already done]')
  })

  it('skips small tool results (< 200 chars)', () => {
    const messages: OaiMessage[] = [
      makeUser('turn 1'),
      makeAssistantWithToolCall('c1', 'grep'),
      makeToolResult('c1', 'small result'),
      makeUser('turn 2'),
      makeUser('turn 3'),
      makeUser('turn 4'),
      makeUser('turn 5'),
      makeUser('turn 6'),
    ]
    requestTimeCollapse(messages, computeCollapseBoundary(messages, 4), 1_000_000)
    assert.equal(messages[2]!.content, 'small result')
  })

  it('does not mutate non-tool messages', () => {
    const messages: OaiMessage[] = [
      makeUser('turn 1'),
      makeAssistantWithToolCall('c1', 'grep'),
      makeToolResult('c1', 'x'.repeat(500)),
      makeUser('turn 2'),
      makeUser('turn 3'),
      makeUser('turn 4'),
      makeUser('turn 5'),
      makeUser('turn 6'),
    ]
    requestTimeCollapse(messages, computeCollapseBoundary(messages, 4), 1_000_000)
    assert.equal(messages[0]!.content, 'turn 1')
    assert.equal(messages[3]!.content, 'turn 2')
  })

  it('does not touch tool results at or above the boundary even if old', () => {
    const messages: OaiMessage[] = [
      makeUser('turn 1'),
      makeAssistantWithToolCall('c1', 'grep'),
      makeToolResult('c1', 'x'.repeat(500)),   // idx 2: below boundary 3 → collapsed
      makeAssistantWithToolCall('c2', 'grep'),
      makeToolResult('c2', 'y'.repeat(500)),   // idx 4: above boundary 3 → untouched
      makeUser('turn 2'),
      makeUser('turn 3'),
      makeUser('turn 4'),
      makeUser('turn 5'),
      makeUser('turn 6'),
    ]
    requestTimeCollapse(messages, 3, 1_000_000)
    assert.notEqual(messages[2]!.content, 'x'.repeat(500))
    assert.equal(messages[4]!.content, 'y'.repeat(500))
  })

  it('frozen boundary produces byte-identical collapse output across repeated calls', () => {
    const build = (): OaiMessage[] => [
      makeUser('turn 1'),
      makeAssistantWithToolCall('c1', 'grep'),
      makeToolResult('c1', Array.from({ length: 50 }, (_, i) => `src/file${i}.ts:10: match`).join('\n')),
      makeUser('turn 2'),
      makeUser('turn 3'),
      makeUser('turn 4'),
      makeUser('turn 5'),
      makeUser('turn 6'),
    ]
    // Same boundary applied to the same history (plus a newer trailing turn)
    // must yield byte-identical content for the collapsed region.
    const a = build()
    requestTimeCollapse(a, 3, 1_000_000)
    const b = [...build(), makeUser('turn 7')]
    requestTimeCollapse(b, 3, 1_000_000)
    assert.equal(a[2]!.content, b[2]!.content)
  })
})
