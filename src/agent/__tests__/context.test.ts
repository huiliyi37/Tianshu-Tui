import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { SessionContext } from '../context.js'
import type { OaiMessage } from '../../api/oai-types.js'
import { isToolMessage } from '../../api/oai-types.js'

describe('SessionContext bounded collections', () => {
  it('evicts oldest filesRead when cap exceeded', () => {
    const ctx = new SessionContext()
    for (let i = 0; i < 502; i++) {
      ctx.trackFileRead(`file-${i}.ts`)
    }
    const files = ctx.getFilesRead()
    assert.ok(files.length <= 500, `expected <= 500, got ${files.length}`)
    assert.ok(files.includes('file-501.ts'), 'should keep newest')
    assert.ok(!files.includes('file-0.ts'), 'should evict oldest')
  })

  it('evicts oldest filesModified when cap exceeded', () => {
    const ctx = new SessionContext()
    for (let i = 0; i < 502; i++) {
      ctx.trackFileModified(`mod-${i}.ts`)
    }
    const files = ctx.getFilesModified()
    assert.ok(files.length <= 500, `expected <= 500, got ${files.length}`)
  })

  it('evicts oldest testResults when cap exceeded', () => {
    const ctx = new SessionContext()
    for (let i = 0; i < 502; i++) {
      ctx.trackTestResult(i, 0)
    }
    const results = ctx.getTestResults()
    assert.ok(results.length <= 500, `expected <= 500, got ${results.length}`)
    assert.equal(results[results.length - 1]!.passed, 501)
  })

  it('evicts oldest turnCacheHistory when cap exceeded', () => {
    const ctx = new SessionContext()
    for (let i = 0; i < 502; i++) {
      ctx.recordTurnCache(i, {
        input_tokens: 100,
        output_tokens: 50,
        cache_read_input_tokens: 80,
        cache_creation_input_tokens: 20,
      })
    }
    const history = ctx.getCacheHistory()
    assert.ok(history.length <= 500, `expected <= 500, got ${history.length}`)
    assert.equal(history[history.length - 1]!.turn, 501)
  })
})

describe('SessionContext OpenAI-native message storage', () => {
  it('stores user messages as OAI messages while exposing legacy view', () => {
    const ctx = new SessionContext()
    ctx.addUserMessage('Hello')

    assert.deepEqual(ctx.getMessages(), [
      { role: 'user', content: 'Hello' },
    ])
  })

  it('converts assistant content blocks to a single OAI assistant message', () => {
    const ctx = new SessionContext()
    ctx.addAssistantBlocks([
      { type: 'thinking', thinking: 'Need to inspect.' },
      { type: 'text', text: 'I will inspect.' },
      { type: 'tool_use', id: 'tu_1', name: 'read_file', input: { file_path: 'src/main.tsx' } },
    ])

    assert.deepEqual(ctx.getMessages(), [
      {
        role: 'assistant',
        content: 'I will inspect.',
        reasoning_content: 'Need to inspect.',
        tool_calls: [
          {
            id: 'tu_1',
            type: 'function',
            function: { name: 'read_file', arguments: '{"file_path":"src/main.tsx"}' },
          },
        ],
      },
    ])
  })

  it('converts legacy tool_result blocks to OAI tool messages', () => {
    const ctx = new SessionContext()
    ctx.addToolResults([
      { type: 'tool_result', tool_use_id: 'tu_1', content: 'ok' },
      { type: 'tool_result', tool_use_id: 'tu_2', content: 'failed', is_error: true },
    ])

    assert.deepEqual(ctx.getMessages(), [
      { role: 'tool', tool_call_id: 'tu_1', content: 'ok' },
      { role: 'tool', tool_call_id: 'tu_2', content: 'failed' },
    ])
  })

  it('stores and retrieves OAI messages directly', () => {
    const ctx = new SessionContext()
    const messages: OaiMessage[] = [
      { role: 'user', content: 'Start' },
      {
        role: 'assistant',
        content: 'Reading.',
        tool_calls: [
          {
            id: 'tu_1',
            type: 'function',
            function: { name: 'read_file', arguments: '{"file_path":"README.md"}' },
          },
        ],
      },
      { role: 'tool', tool_call_id: 'tu_1', content: 'contents' },
    ]

    ctx.replaceMessages(messages)

    assert.deepEqual(ctx.getMessages(), messages)
  })
})


it('getLatestTurnHitRate returns null with no turn cache snapshots', () => {
  const ctx = new SessionContext()
  assert.equal(ctx.getLatestTurnHitRate(), null)
})

it('getLatestTurnHitRate returns null when latest turn has no cache counters', () => {
  const ctx = new SessionContext()
  ctx.recordTurnCache(1, {
    input_tokens: 100,
    output_tokens: 10,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
  })

  assert.equal(ctx.getLatestTurnHitRate(), null)
})

it('getLatestTurnHitRate returns latest turn cache read ratio', () => {
  const ctx = new SessionContext()
  ctx.recordTurnCache(1, {
    input_tokens: 100,
    output_tokens: 10,
    cache_read_input_tokens: 20,
    cache_creation_input_tokens: 80,
  })
  ctx.recordTurnCache(2, {
    input_tokens: 100,
    output_tokens: 10,
    cache_read_input_tokens: 75,
    cache_creation_input_tokens: 25,
  })

  assert.equal(ctx.getLatestTurnHitRate(), 0.75)
})

describe('getRecentTurnHitRate', () => {
  it('returns null with no turn cache snapshots', () => {
    const ctx = new SessionContext()
    assert.equal(ctx.getRecentTurnHitRate(3), null)
  })

  it('returns average over available turns when fewer than requested', () => {
    const ctx = new SessionContext()
    ctx.recordTurnCache(1, {
      input_tokens: 100,
      output_tokens: 10,
      cache_read_input_tokens: 80,
      cache_creation_input_tokens: 20,
    })
    assert.equal(ctx.getRecentTurnHitRate(3), 0.8)
  })

  it('returns average over last N turns', () => {
    const ctx = new SessionContext()
    ctx.recordTurnCache(1, {
      input_tokens: 100,
      output_tokens: 10,
      cache_read_input_tokens: 90,
      cache_creation_input_tokens: 10,
    })
    ctx.recordTurnCache(2, {
      input_tokens: 100,
      output_tokens: 10,
      cache_read_input_tokens: 30,
      cache_creation_input_tokens: 70,
    })
    ctx.recordTurnCache(3, {
      input_tokens: 100,
      output_tokens: 10,
      cache_read_input_tokens: 60,
      cache_creation_input_tokens: 40,
    })
    // Last 2 turns aggregated: (30+60) / ((30+70)+(60+40)) = 90/200 = 0.45
    assert.equal(ctx.getRecentTurnHitRate(2), 0.45)
  })

  it('returns null when all turns have zero cache counters', () => {
    const ctx = new SessionContext()
    ctx.recordTurnCache(1, {
      input_tokens: 100,
      output_tokens: 10,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    })
    assert.equal(ctx.getRecentTurnHitRate(3), null)
  })
})

describe('SessionContext mutation listener', () => {
  it('emits append on addUserMessage', () => {
    const ctx = new SessionContext()
    const events: Array<{ type: string; role?: string; len?: number }> = []
    ctx.setMutationListener(m => {
      if (m.type === 'append') events.push({ type: 'append', role: m.message.role })
      else events.push({ type: 'replace', len: m.messages.length })
    })

    ctx.addUserMessage('hello')
    assert.deepEqual(events, [{ type: 'append', role: 'user' }])
  })

  it('emits append on addAssistantBlocks (text only)', () => {
    const ctx = new SessionContext()
    const seen: OaiMessage[] = []
    ctx.setMutationListener(m => {
      if (m.type === 'append') seen.push(m.message)
    })

    ctx.addAssistantBlocks([{ type: 'text', text: 'hi there' }])
    assert.equal(seen.length, 1)
    assert.equal(seen[0]!.role, 'assistant')
    assert.equal(seen[0]!.content, 'hi there')
  })

  it('emits append on addAssistantBlocks (tool_use)', () => {
    const ctx = new SessionContext()
    const seen: OaiMessage[] = []
    ctx.setMutationListener(m => {
      if (m.type === 'append') seen.push(m.message)
    })

    ctx.addAssistantBlocks([
      { type: 'tool_use', id: 'call_1', name: 'read_file', input: { path: 'a.ts' } },
    ])
    assert.equal(seen.length, 1)
    assert.equal(seen[0]!.role, 'assistant')
    assert.ok(seen[0]!.tool_calls)
    assert.equal(seen[0]!.tool_calls!.length, 1)
    assert.equal(seen[0]!.tool_calls![0]!.id, 'call_1')
  })

  it('emits one append per tool_result in addToolResults', () => {
    const ctx = new SessionContext()
    const seen: OaiMessage[] = []
    ctx.setMutationListener(m => {
      if (m.type === 'append') seen.push(m.message)
    })

    ctx.addToolResults([
      { type: 'tool_result', tool_use_id: 'call_1', content: 'a-content' },
      { type: 'tool_result', tool_use_id: 'call_2', content: 'b-content' },
    ])
    assert.equal(seen.length, 2)
    const first = seen[0]!
    const second = seen[1]!
    assert.ok(isToolMessage(first), 'first should be tool message')
    assert.ok(isToolMessage(second), 'second should be tool message')
    assert.equal(first.tool_call_id, 'call_1')
    assert.equal(second.tool_call_id, 'call_2')
    assert.equal(first.content, 'a-content')
  })

  it('emits replace on replaceMessages', () => {
    const ctx = new SessionContext()
    const events: Array<{ type: string; len?: number }> = []
    ctx.setMutationListener(m => {
      if (m.type === 'replace') events.push({ type: 'replace', len: m.messages.length })
      else events.push({ type: 'append' })
    })

    const msgs: OaiMessage[] = [
      { role: 'user', content: 'a' },
      { role: 'assistant', content: 'b' },
    ]
    ctx.replaceMessages(msgs)
    assert.deepEqual(events, [{ type: 'replace', len: 2 }])
  })

  it('replace event snapshots the array (no aliasing with future mutations)', () => {
    // Regression guard: a listener that defers work (e.g. async disk write)
    // must see the messages as-they-were when replace fired, not include
    // anything pushed afterward.
    const ctx = new SessionContext()
    let captured: OaiMessage[] | null = null
    ctx.setMutationListener(m => {
      if (m.type === 'replace') captured = m.messages
    })

    ctx.replaceMessages([{ role: 'user', content: 'compacted' }])
    // After replace, push something else; the captured array must not grow.
    ctx.addAssistantBlocks([{ type: 'text', text: 'next' }])

    if (!captured) {
      assert.fail('replace event should have fired')
    }
    const cap: OaiMessage[] = captured
    assert.equal(cap.length, 1)
    const first = cap[0]!
    assert.equal(first.role, 'user')
    assert.equal(first.content, 'compacted')
  })

  it('does not invoke listener before subscription', () => {
    const ctx = new SessionContext()
    ctx.addUserMessage('before-subscribe') // should not throw, no listener yet

    let called = false
    ctx.setMutationListener(() => { called = true })
    assert.equal(called, false)

    ctx.addUserMessage('after-subscribe')
    assert.equal(called, true)
  })

  it('listener exception in one event does not block subsequent events', () => {
    // The listener is sync so a thrown exception will propagate. The contract:
    // once a listener throws, the caller (AgentLoop) is responsible for catching.
    // This test documents the synchronous behavior so callers know to wrap.
    const ctx = new SessionContext()
    let throws = true
    ctx.setMutationListener(() => {
      if (throws) {
        throws = false
        throw new Error('listener error')
      }
    })

    assert.throws(() => ctx.addUserMessage('first'), /listener error/)
    // Second call: listener no longer throws.
    assert.doesNotThrow(() => ctx.addUserMessage('second'))
  })
})

describe('SessionContext removeLastMessage', () => {
  it('removes the last user message and decrements turnCount', () => {
    const ctx = new SessionContext()
    ctx.addUserMessage('hello')
    assert.equal(ctx.getTurnCount(), 1)
    assert.equal(ctx.getMessages().length, 1)

    const removed = ctx.removeLastMessage()
    assert.equal(removed!.role, 'user')
    assert.equal((removed as any).content, 'hello')
    assert.equal(ctx.getMessages().length, 0)
    assert.equal(ctx.getTurnCount(), 0)
  })

  it('throws when top message is assistant (not user)', () => {
    const ctx = new SessionContext()
    ctx.addUserMessage('hello')
    ctx.addAssistantBlocks([{ type: 'text', text: 'world' }])
    assert.equal(ctx.getTurnCount(), 1)
    assert.equal(ctx.getMessages().length, 2)

    assert.throws(
      () => ctx.removeLastMessage(),
      /removeLastMessage: expected user message but top was assistant/,
    )
    // State must be restored — assistant message should still be on the stack
    assert.equal(ctx.getMessages().length, 2)
    assert.equal(ctx.getMessages()[1]!.role, 'assistant')
  })

  it('returns undefined when session is empty', () => {
    const ctx = new SessionContext()
    assert.equal(ctx.removeLastMessage(), undefined)
  })

  it('decrements estimatedTokens', () => {
    const ctx = new SessionContext()
    const before = ctx.getEstimatedTokens()
    ctx.addUserMessage('hello world')
    const after = ctx.getEstimatedTokens()
    assert.ok(after > before, 'tokens should increase after addUserMessage')

    ctx.removeLastMessage()
    assert.equal(ctx.getEstimatedTokens(), before, 'tokens should return to baseline after removeLastMessage')
  })

  it('throws when attempting to rollback tool or assistant messages', () => {
    const ctx = new SessionContext()
    ctx.addUserMessage('do stuff')
    ctx.addAssistantBlocks([
      { type: 'tool_use', id: 'c1', name: 'bash', input: { command: 'ls' } },
    ])
    ctx.addToolResults([{ type: 'tool_result', tool_use_id: 'c1', content: 'file.ts' }])

    assert.equal(ctx.getMessages().length, 3)

    // Tool message is on top — removeLastMessage must throw
    assert.throws(
      () => ctx.removeLastMessage(),
      /removeLastMessage: expected user message but top was tool/,
    )
    // State unchanged after throw
    assert.equal(ctx.getMessages().length, 3)
    assert.equal(ctx.getTurnCount(), 1)
  })

  it('rollbacks a lone user message after failed turn (no assistant response)', () => {
    const ctx = new SessionContext()
    ctx.addUserMessage('do stuff')
    // Simulate: turn was aborted before assistant responded
    // (in production, loop.ts guarantees this via !assistantResponded)
    assert.equal(ctx.getMessages().length, 1)
    assert.equal(ctx.getTurnCount(), 1)

    const removed = ctx.removeLastMessage()
    assert.equal(removed!.role, 'user')
    assert.equal(ctx.getMessages().length, 0)
    assert.equal(ctx.getTurnCount(), 0)
  })

  it('emits replace mutation on user message removal', () => {
    const ctx = new SessionContext()
    const events: Array<{ type: string; messages?: OaiMessage[] }> = []
    ctx.setMutationListener(m => {
      if (m.type === 'replace') events.push({ type: 'replace', messages: m.messages.slice() })
      else events.push({ type: 'append' })
    })

    ctx.addUserMessage('hello')
    assert.deepEqual(events, [
      { type: 'append' },
    ])

    // Remove the user message — should emit replace with empty array
    events.length = 0
    const removed = ctx.removeLastMessage()
    assert.equal(removed!.role, 'user')
    assert.equal(events.length, 1)
    assert.equal(events[0]!.type, 'replace')
    assert.equal(events[0]!.messages!.length, 0)
  })

  it('does not emit mutation when session is empty (nothing to remove)', () => {
    const ctx = new SessionContext()
    let called = false
    ctx.setMutationListener(() => { called = true })

    const result = ctx.removeLastMessage()
    assert.equal(result, undefined)
    assert.equal(called, false, 'should not emit mutation when nothing was removed')
  })

  it('does not emit mutation and restores state when guard throws', () => {
    const ctx = new SessionContext()
    ctx.addUserMessage('hello')
    ctx.addAssistantBlocks([{ type: 'text', text: 'world' }])

    let mutationFired = false
    ctx.setMutationListener(() => { mutationFired = true })

    assert.throws(
      () => ctx.removeLastMessage(),
      /removeLastMessage: expected user message but top was assistant/,
    )
    assert.equal(mutationFired, false, 'no mutation when guard throws')
    assert.equal(ctx.getMessages().length, 2, 'state fully restored')
    assert.equal(ctx.getEstimatedTokens() > 0, true, 'tokens not corrupted')
  })
})
