import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { microcompactToolResults } from '../microcompact.js'
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

describe('microcompactToolResults', () => {
  it('returns messages unchanged when few rounds', () => {
    const messages: Message[] = [
      userText('Hi'),
      assistantText('Hello'),
    ]
    const result = microcompactToolResults(messages)

    assert.equal(result.compactedCount, 0)
    assert.equal(result.tokensSaved, 0)
    assert.deepEqual(result.messages, messages)
  })

  it('compacts large tool_result content in old rounds', () => {
    const bigContent = 'line1\n' + 'x'.repeat(600) + '\nlast line'
    const messages: Message[] = [
      userText('Search'),
      assistantWithTools(['tu_1']),
      userWithToolResults([{ id: 'tu_1', content: bigContent }]),
      assistantText('Done'),
      userText('Another'),
      assistantText('Ack'),
      userText('Third'),
      assistantText('Done 3'),
    ]

    const result = microcompactToolResults(messages, { keepRecentRounds: 2, minContentLength: 500 })

    assert.ok(result.compactedCount > 0)
    assert.ok(result.tokensSaved > 0)
    assert.ok(result.compactedRoundIds.length > 0)

    const compactedMsg = result.messages[2]!
    const blocks = typeof compactedMsg.content === 'string' ? null : compactedMsg.content
    assert.ok(blocks)
    const trBlock = blocks.find(b => b.type === 'tool_result')
    assert.ok(trBlock)
    if (trBlock.type === 'tool_result') {
      assert.ok(trBlock.content.includes('compacted'))
      assert.ok(trBlock.content.length < bigContent.length)
    }
  })

  it('preserves error tool_results unchanged', () => {
    const bigContent = 'x'.repeat(600)
    const messages: Message[] = [
      userText('Error search'),
      assistantWithTools(['tu_err']),
      userWithBlocks([toolResult('tu_err', bigContent, true)]),
      assistantText('Failed'),
      userText('Another'),
      assistantText('Ack'),
      userText('Third'),
      assistantText('Done 3'),
    ]

    const result = microcompactToolResults(messages, { keepRecentRounds: 2, minContentLength: 500 })

    const errMsg = result.messages[2]!
    const blocks = typeof errMsg.content === 'string' ? null : errMsg.content
    assert.ok(blocks)
    const errBlock = blocks.find(b => b.type === 'tool_result')
    assert.ok(errBlock)
    if (errBlock.type === 'tool_result') {
      assert.equal(errBlock.is_error, true)
      assert.equal(errBlock.content, bigContent)
    }
  })

  it('preserves recent rounds untouched', () => {
    const bigContent = 'x'.repeat(600)
    const messages: Message[] = [
      userText('Old search'),
      assistantWithTools(['tu_old']),
      userWithToolResults([{ id: 'tu_old', content: bigContent }]),
      assistantText('Old done'),
      userText('Recent search'),
      assistantWithTools(['tu_recent']),
      userWithToolResults([{ id: 'tu_recent', content: bigContent }]),
      assistantText('Recent done'),
    ]

    const result = microcompactToolResults(messages, { keepRecentRounds: 4, minContentLength: 500 })

    const recentMsg = result.messages[6]!
    const recentBlocks = typeof recentMsg.content === 'string' ? null : recentMsg.content
    assert.ok(recentBlocks)
    const recentTR = recentBlocks.find(b => b.type === 'tool_result')
    assert.ok(recentTR)
    if (recentTR.type === 'tool_result') {
      assert.equal(recentTR.content, bigContent, 'recent untouched')
    }

    const oldMsg = result.messages[2]!
    const oldBlocks = typeof oldMsg.content === 'string' ? null : oldMsg.content
    assert.ok(oldBlocks)
    const oldTR = oldBlocks.find(b => b.type === 'tool_result')
    assert.ok(oldTR)
    if (oldTR.type === 'tool_result') {
      assert.ok(oldTR.content.includes('compacted'), 'old compacted')
    }
  })

  it('does not compact small results', () => {
    const messages: Message[] = [
      userText('Search'),
      assistantWithTools(['tu_1']),
      userWithToolResults([{ id: 'tu_1', content: 'tiny' }]),
      assistantText('Done'),
      userText('Another'),
      assistantText('Ack'),
      userText('Third'),
      assistantText('Done 3'),
    ]

    const result = microcompactToolResults(messages, { keepRecentRounds: 2, minContentLength: 500 })
    assert.equal(result.compactedCount, 0)
  })
})
