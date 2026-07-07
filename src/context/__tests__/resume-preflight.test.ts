import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { runResumePreflight } from '../resume-preflight.js'
import type { Message, ContentBlock } from '../../api/types.js'

function userText(content: string): Message {
  return { role: 'user', content }
}

function assistantText(content: string): Message {
  return { role: 'assistant', content }
}

function assistantWithBlocks(blocks: ContentBlock[]): Message {
  return { role: 'assistant', content: blocks }
}

function userWithBlocks(blocks: ContentBlock[]): Message {
  return { role: 'user', content: blocks }
}

function toolUse(id: string, name = 'test_tool'): ContentBlock & { type: 'tool_use' } {
  return { type: 'tool_use', id, name, input: {} }
}

function toolResult(id: string, content: string, isError = false): ContentBlock & { type: 'tool_result' } {
  return { type: 'tool_result', tool_use_id: id, content, is_error: isError }
}

function assistantWithTools(ids: string[]): Message {
  return assistantWithBlocks(ids.map(id => toolUse(id)))
}

function userWithToolResults(results: Array<{ id: string; content: string }>): Message {
  return userWithBlocks(results.map(r => toolResult(r.id, r.content)))
}

describe('runResumePreflight', () => {
  it('reports no repair for clean sessions', () => {
    const messages: Message[] = [
      userText('Hello'),
      assistantText('Hi!'),
    ]
    const report = runResumePreflight(messages)
    assert.equal(report.repaired, false)
    assert.equal(report.syntheticResultsInserted, 0)
    assert.equal(report.invariant.brokenRounds, 0)
    assert.deepEqual(report.messages, messages)
  })

  it('inserts synthetic tool_results for orphan tool_use', () => {
    const messages: Message[] = [
      userText('Do it'),
      assistantWithTools(['tu_1', 'tu_2']),
    ]
    const report = runResumePreflight(messages)
    assert.equal(report.repaired, true)
    assert.equal(report.syntheticResultsInserted, 2)
    assert.equal(report.messages.length, 3)
    const syntheticMsg = report.messages[2]!
    assert.equal(syntheticMsg.role, 'user')
    assert.ok(typeof syntheticMsg.content !== 'string')
    const blocks = syntheticMsg.content as ContentBlock[]
    assert.equal(blocks.length, 2)
    const ids = blocks.filter(b => b.type === 'tool_result').map(b => b.tool_use_id).sort()
    assert.deepEqual(ids, ['tu_1', 'tu_2'])
    for (const block of blocks) {
      if (block.type === 'tool_result') {
        assert.equal(block.is_error, true)
        assert.ok(block.content.includes('interrupted'))
      }
    }
  })

  it('returns same messages when no repair needed', () => {
    const messages: Message[] = [
      userText('Read'),
      assistantWithTools(['tu_r']),
      userWithToolResults([{ id: 'tu_r', content: 'ok' }]),
      assistantText('Done'),
    ]
    const report = runResumePreflight(messages)
    assert.equal(report.repaired, false)
    assert.equal(report.invariant.brokenRounds, 0)
  })

  it('returns no repair for longer clean session', () => {
    const messages = [
      userText('Hello'), assistantText('Hi!'),
      userText('Find bug'), assistantWithTools(['tu_1']),
      userWithToolResults([{ id: 'tu_1', content: 'found' }]),
      assistantText('Done'),
    ]
    const report = runResumePreflight(messages)
    assert.equal(report.repaired, false)
    assert.equal(report.syntheticResultsInserted, 0)
    assert.equal(report.invariant.brokenRounds, 0)
  })

  it('inserts synthetic tool_result for orphan tool_use in multi-turn', () => {
    const messages = [
      userText('Find bug'),
      assistantWithTools(['tu_1', 'tu_2']),
    ]
    const report = runResumePreflight(messages)
    assert.equal(report.repaired, true)
    assert.equal(report.syntheticResultsInserted, 2)
    assert.equal(report.messages.length, 3)
    const repairMsg = report.messages[2]!
    assert.equal(repairMsg.role, 'user')
    const blocks = typeof repairMsg.content === 'string' ? null : repairMsg.content
    assert.ok(blocks)
    assert.equal(blocks.length, 2)
    const first = blocks[0]!
    assert.equal(first.type, 'tool_result')
    if (first.type === 'tool_result') {
      assert.equal(first.is_error, true)
      assert.ok(first.content.includes('interrupted'))
    }
  })

  it('detects orphan tool_results without repair', () => {
    const messages = [
      userText('Task'),
      userWithToolResults([{ id: 'tu_orphan', content: 'stale' }]),
      assistantText('OK'),
    ]
    const report = runResumePreflight(messages)
    assert.equal(report.repaired, false)
    assert.ok(report.orphanToolResultIds.length > 0)
  })
})
