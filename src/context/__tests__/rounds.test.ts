import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { groupIntoRounds, computeInvariantStatus, getSafeCutIndices } from '../rounds.js'
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

describe('groupIntoRounds', () => {
  it('groups a simple user→assistant exchange (no tools) into two rounds', () => {
    const messages: Message[] = [
      userText('Hello'),
      assistantText('Hi there!'),
    ]

    const rounds = groupIntoRounds(messages)
    assert.equal(rounds.length, 2)
    assert.equal(rounds[0]!.id, 'round_0')
    assert.equal(rounds[0]!.startMessageIndex, 0)
    assert.equal(rounds[0]!.endMessageIndex, 1)
    assert.equal(rounds[0]!.turnNumber, 1)
    assert.equal(rounds[0]!.hasToolUse, false)
    assert.equal(rounds[0]!.apiInvariant, 'ok')

    assert.equal(rounds[1]!.id, 'round_1')
    assert.equal(rounds[1]!.startMessageIndex, 1)
    assert.equal(rounds[1]!.endMessageIndex, 2)
    assert.equal(rounds[1]!.hasToolUse, false)
    assert.equal(rounds[1]!.apiInvariant, 'ok')
  })

  it('groups a ToolExchange: assistant(tool_use) + user(tool_result) as one round', () => {
    const messages: Message[] = [
      userText('Find the bug'),
      assistantWithTools(['tu_1']),
      userWithToolResults([{ id: 'tu_1', content: 'Found in auth.ts' }]),
      assistantText('Based on findings...'),
    ]

    const rounds = groupIntoRounds(messages)
    assert.equal(rounds.length, 3)

    assert.equal(rounds[0]!.apiInvariant, 'ok')
    assert.equal(rounds[0]!.hasToolUse, false)

    assert.equal(rounds[1]!.id, 'round_1')
    assert.equal(rounds[1]!.startMessageIndex, 1)
    assert.equal(rounds[1]!.endMessageIndex, 3)
    assert.equal(rounds[1]!.hasToolUse, true)
    assert.equal(rounds[1]!.hasToolResult, true)
    assert.equal(rounds[1]!.apiInvariant, 'ok')

    assert.equal(rounds[2]!.id, 'round_2')
    assert.equal(rounds[2]!.startMessageIndex, 3)
    assert.equal(rounds[2]!.endMessageIndex, 4)
    assert.equal(rounds[2]!.hasToolUse, false)
  })

  it('groups multiple tool_use/tool_result pairs in separate rounds', () => {
    const messages: Message[] = [
      userText('Fix the bug'),
      assistantWithTools(['tu_1']),
      userWithToolResults([{ id: 'tu_1', content: 'read' }]),
      assistantWithTools(['tu_2']),
      userWithToolResults([{ id: 'tu_2', content: 'edit' }]),
      assistantText('Done'),
    ]

    const rounds = groupIntoRounds(messages)
    assert.equal(rounds.length, 4)

    assert.equal(rounds[1]!.hasToolUse, true)
    assert.equal(rounds[1]!.hasToolResult, true)
    assert.equal(rounds[1]!.endMessageIndex, 3)

    assert.equal(rounds[2]!.hasToolUse, true)
    assert.equal(rounds[2]!.hasToolResult, true)
    assert.equal(rounds[2]!.startMessageIndex, 3)
    assert.equal(rounds[2]!.endMessageIndex, 5)

    assert.equal(rounds[3]!.hasToolUse, false)
    assert.equal(rounds[3]!.startMessageIndex, 5)
  })

  it('detects broken round: tool_use without matching tool_result', () => {
    const messages: Message[] = [
      userText('Do something'),
      assistantWithTools(['tu_1']),
      userText('Next thing'),
      assistantText('OK'),
    ]

    const rounds = groupIntoRounds(messages)
    assert.equal(rounds.length, 4)

    assert.equal(rounds[1]!.hasToolUse, true)
    assert.equal(rounds[1]!.hasToolResult, false)
    assert.equal(rounds[1]!.apiInvariant, 'broken')
    assert.equal(rounds[1]!.endMessageIndex - rounds[1]!.startMessageIndex, 1)
  })

  it('detects repaired round: orphan tool_results without tool_use', () => {
    const messages: Message[] = [
      userWithToolResults([{ id: 'tu_orphan', content: 'lost result' }]),
      assistantText('OK'),
    ]

    const rounds = groupIntoRounds(messages)
    assert.equal(rounds.length, 2)

    assert.equal(rounds[0]!.hasToolUse, false)
    assert.equal(rounds[0]!.hasToolResult, true)
    assert.equal(rounds[0]!.apiInvariant, 'repaired')
  })

  it('handles multiple tool_use IDs in a single assistant message', () => {
    const messages: Message[] = [
      userText('Search'),
      assistantWithBlocks([toolUse('tu_a'), toolUse('tu_b')]),
      userWithToolResults([
        { id: 'tu_a', content: 'A' },
        { id: 'tu_b', content: 'B' },
      ]),
      assistantText('Results'),
    ]

    const rounds = groupIntoRounds(messages)
    assert.equal(rounds.length, 3)

    assert.equal(rounds[1]!.hasToolUse, true)
    assert.equal(rounds[1]!.hasToolResult, true)
    assert.equal(rounds[1]!.apiInvariant, 'ok')
  })

  it('handles partial tool_result matches as repaired', () => {
    const messages: Message[] = [
      userText('Search'),
      assistantWithBlocks([toolUse('tu_a'), toolUse('tu_b')]),
      userWithBlocks([toolResult('tu_a', 'A')]),
      assistantText('Partial'),
    ]

    const rounds = groupIntoRounds(messages)
    assert.equal(rounds[1]!.apiInvariant, 'broken', 'missing tool_result for tu_b')
  })

  it('correctly sets compactableTokenEstimate', () => {
    const bigContent = 'x'.repeat(1000)
    const messages: Message[] = [
      userText('Search'),
      assistantWithTools(['tu_1']),
      userWithToolResults([{ id: 'tu_1', content: bigContent }]),
      assistantText('Done'),
    ]

    const rounds = groupIntoRounds(messages)
    assert.ok(rounds[1]!.compactableTokenEstimate > 0, 'large tool_result should be compactable')
  })

  it('sets compactableTokenEstimate to 0 for small results', () => {
    const messages: Message[] = [
      userText('Search'),
      assistantWithTools(['tu_1']),
      userWithToolResults([{ id: 'tu_1', content: 'tiny' }]),
      assistantText('Done'),
    ]

    const rounds = groupIntoRounds(messages)
    assert.equal(rounds[1]!.compactableTokenEstimate, 0, 'small result not compactable')
  })

  it('assigns incremental turn numbers', () => {
    const messages: Message[] = [
      userText('First'),
      assistantText('Ack'),
      userText('Second'),
      assistantWithTools(['tu_1']),
      userWithToolResults([{ id: 'tu_1', content: 'ok' }]),
      assistantText('Done'),
      userText('Third'),
      assistantText('Ack'),
    ]

    const rounds = groupIntoRounds(messages)
    for (const r of rounds) {
      assert.ok(r.turnNumber >= 1)
    }
  })
})

describe('getSafeCutIndices', () => {
  it('returns round boundaries as safe cut points', () => {
    const messages: Message[] = [
      userText('T1'), assistantText('R1'),
      userText('T2'), assistantText('R2'),
    ]
    const rounds = groupIntoRounds(messages)

    const cuts = getSafeCutIndices(rounds)
    assert.deepEqual(cuts, [1, 2, 3], 'cut after each round except last')
  })

  it('returns boundaries that never split a ToolExchange', () => {
    const messages: Message[] = [
      userText('Find'),
      assistantWithTools(['tu_1']),
      userWithToolResults([{ id: 'tu_1', content: 'ok' }]),
      assistantText('Done'),
    ]
    const rounds = groupIntoRounds(messages)

    const cuts = getSafeCutIndices(rounds)
    assert.deepEqual(cuts, [1, 3])
    assert.ok(!cuts.includes(2))
  })
})

describe('computeInvariantStatus', () => {
  it('reports all ok for a clean session', () => {
    const messages: Message[] = [
      userText('Hi'),
      assistantText('Hello'),
    ]
    const rounds = groupIntoRounds(messages)
    const status = computeInvariantStatus(rounds)

    assert.equal(status.totalRounds, 2)
    assert.equal(status.okRounds, 2)
    assert.equal(status.repairedRounds, 0)
    assert.equal(status.brokenRounds, 0)
  })

  it('counts repaired and broken rounds', () => {
    const messages: Message[] = [
      assistantWithTools(['tu_1']),
      userText('Next'),
      userWithToolResults([{ id: 'tu_orphan', content: 'x' }]),
      assistantText('OK'),
    ]
    const rounds = groupIntoRounds(messages)
    const status = computeInvariantStatus(rounds)

    assert.equal(status.brokenRounds, 1)
    assert.equal(status.repairedRounds, 1)
    assert.ok(status.orphanToolUse.length > 0)
    assert.ok(status.orphanToolResult.length > 0)
  })
})
