import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { requestTimeCollapse } from '../engine.js'
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

describe('requestTimeCollapse', () => {
  it('does not collapse recent tool results (age < collapseAge)', () => {
    const messages: OaiMessage[] = [
      makeUser('task 1'),
      makeAssistantWithToolCall('c1', 'grep'),
      makeToolResult('c1', 'x'.repeat(500)),
      makeUser('task 2'),
    ]
    const original = messages[2]!.content
    requestTimeCollapse(messages, 4, 1_000_000)
    assert.equal(messages[2]!.content, original)
  })

  it('collapses old tool results (age >= collapseAge)', () => {
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
    requestTimeCollapse(messages, 4, 1_000_000)
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
    requestTimeCollapse(messages, 4, 1_000_000)
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
    requestTimeCollapse(messages, 4, 1_000_000)
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
    requestTimeCollapse(messages, 4, 1_000_000)
    assert.equal(messages[0]!.content, 'turn 1')
    assert.equal(messages[3]!.content, 'turn 2')
  })
})
