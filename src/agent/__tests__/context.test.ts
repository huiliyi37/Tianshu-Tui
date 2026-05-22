import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { SessionContext } from '../context.js'
import type { Message } from '../../api/types.js'

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

    assert.deepEqual(ctx.getOaiMessages(), [
      { role: 'user', content: 'Hello' },
    ])
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

    assert.deepEqual(ctx.getOaiMessages(), [
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
    assert.deepEqual(ctx.getMessages(), [
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'Need to inspect.' },
          { type: 'text', text: 'I will inspect.' },
          { type: 'tool_use', id: 'tu_1', name: 'read_file', input: { file_path: 'src/main.tsx' } },
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

    assert.deepEqual(ctx.getOaiMessages(), [
      { role: 'tool', tool_call_id: 'tu_1', content: 'ok' },
      { role: 'tool', tool_call_id: 'tu_2', content: 'failed' },
    ])
    assert.deepEqual(ctx.getMessages(), [
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'tu_1', content: 'ok' },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'tu_2', content: 'failed' },
        ],
      },
    ])
  })

  it('migrates loaded legacy messages to OAI canonical storage', () => {
    const ctx = new SessionContext()
    const messages: Message[] = [
      { role: 'user', content: 'Start' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Reading.' },
          { type: 'tool_use', id: 'tu_1', name: 'read_file', input: { file_path: 'README.md' } },
        ],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'contents' }],
      },
    ]

    ctx.loadMessages(messages)

    assert.deepEqual(ctx.getOaiMessages(), [
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
    ])
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
