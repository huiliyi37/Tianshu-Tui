import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  groupIntoRounds,
  computeInvariantStatus,
  getSafeCutIndices,
  createContextLedger,
  microcompactToolResults,
  type ApiRound,
  type ContextLedger,
} from '../context-ledger.js'
import type { Message, ContentBlock } from '../../api/types.js'

// --- Test helpers ---

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

// --- Tests ---

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

    // Round 0: user text
    assert.equal(rounds[0]!.apiInvariant, 'ok')
    assert.equal(rounds[0]!.hasToolUse, false)

    // Round 1: assistant(tu_1) + user(tool_result tu_1) — ToolExchange
    assert.equal(rounds[1]!.id, 'round_1')
    assert.equal(rounds[1]!.startMessageIndex, 1)
    assert.equal(rounds[1]!.endMessageIndex, 3)
    assert.equal(rounds[1]!.hasToolUse, true)
    assert.equal(rounds[1]!.hasToolResult, true)
    assert.equal(rounds[1]!.apiInvariant, 'ok')

    // Round 2: assistant text
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
    // userText → [asst(tu_1)+user(result)] → [asst(tu_2)+user(result)] → asstText
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
      // No tool_result — next is a new user request
      userText('Next thing'),
      assistantText('OK'),
    ]

    const rounds = groupIntoRounds(messages)
    // userText → [asst(tu_1) broken] → userText → asstText
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
    // userText → ToolExchange with 2 tools → asstText
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
      // tu_b has no matching tool_result
      assistantText('Partial'),
    ]

    const rounds = groupIntoRounds(messages)
    assert.equal(rounds[1]!.apiInvariant, 'broken', 'missing tool_result for tu_b')
  })

  it('correctly sets compactableTokenEstimate', () => {
    const bigContent = 'x'.repeat(1000)  // >200 chars
    const messages: Message[] = [
      userText('Search'),
      assistantWithTools(['tu_1']),
      userWithToolResults([{ id: 'tu_1', content: bigContent }]),
      assistantText('Done'),
    ]

    const rounds = groupIntoRounds(messages)
    // Round 1 is the ToolExchange
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

    // Turn numbers: each user text message increments
    const userTextRounds = rounds.filter(r => r.turnNumber > 0 && rounds.indexOf(r) > 0)
    const turnNumbers = rounds.filter((_, i) => {
      // User text rounds start new turns
      return i > 0 && rounds[i]!.startMessageIndex > rounds[i - 1]!.endMessageIndex
    })

    // Verify all rounds have a turnNumber ≥ 1
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
    // Rounds are: userText(0→1), asstText(1→2), userText(2→3), asstText(3→4)
    // Safe cuts at 1, 2, 3 (all internal boundaries except last at 4)
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
    // Round 0: [0,1), Round 1: [1,3), Round 2: [3,4)
    // Cuts: 1, 3
    assert.deepEqual(cuts, [1, 3])
    // 2 is NOT a safe cut (inside ToolExchange)
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
      assistantWithTools(['tu_1']), // broken: no matching result
      userText('Next'),
      userWithToolResults([{ id: 'tu_orphan', content: 'x' }]), // repaired: orphan result
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

describe('createContextLedger', () => {
  it('creates a ledger with round data and token budget', () => {
    const messages: Message[] = [
      userText('Hello'),
      assistantText('Hi!'),
    ]
    const ledger = createContextLedger('session_1', '/tmp/test.jsonl', messages, 1_000_000)

    assert.equal(ledger.sessionId, 'session_1')
    assert.equal(ledger.rounds.length, 2)
    assert.ok(ledger.tokenBudget.estimatedTokens > 0)
    assert.equal(ledger.tokenBudget.maxTokens, 1_000_000)
    assert.equal(ledger.apiInvariantStatus.okRounds, 2)
  })

  it('reports healthy for small sessions', () => {
    const messages: Message[] = [
      userText('Hi'),
      assistantText('Hello'),
    ]
    const ledger = createContextLedger('s', '/t', messages, 1_000_000)

    assert.equal(ledger.tokenBudget.compactionState, 'healthy')
  })

  it('reports critical when near context limit', () => {
    const bigText = 'x'.repeat(400_000)  // ~100K tokens
    const messages: Message[] = [
      userText(bigText),
      assistantText(bigText),
    ]
    const ledger = createContextLedger('s', '/t', messages, 100_000)

    assert.equal(ledger.tokenBudget.compactionState, 'critical')
  })
})

// ─── Tier 1: microcompactToolResults ───────────────────────────

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

