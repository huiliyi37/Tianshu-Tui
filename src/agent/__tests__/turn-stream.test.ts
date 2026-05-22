import { describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'
import { TurnStreamController } from '../turn-stream.js'
import type { StreamCallbacks } from '../../api/stream-client.js'
import type { StreamClient } from '../../api/stream-client.js'
import type { OaiChatRequest } from '../../api/oai-types.js'
import type { Usage } from '../../api/types.js'

const request: OaiChatRequest = {
  model: 'test-model',
  messages: [],
  max_tokens: 1024,
}

function makeController(client: StreamClient) {
  let streamedText = ''
  let lastPrewarmAt = 0
  const usage: Partial<Usage>[] = []
  const turnCaches: Array<{ turn: number; usage: Usage }> = []
  const prewarmed: string[] = []

  const controller = new TurnStreamController({
    client,
    abortSignal: new AbortController().signal,
    getStreamedTextLength: () => streamedText.length,
    appendStreamedText: text => { streamedText += text },
    getLastPrewarmAt: () => lastPrewarmAt,
    setLastPrewarmAt: position => { lastPrewarmAt = position },
    maybePrewarm: text => { prewarmed.push(text) },
    addUsage: u => { usage.push(u) },
    recordTurnCache: (turn, u) => { turnCaches.push({ turn, usage: u }) },
  })

  return { controller, getStreamedText: () => streamedText, usage, turnCaches, prewarmed }
}

describe('TurnStreamController', () => {
  it('collects text, thinking, tool uses, usage, and cache counters', async () => {
    const client: StreamClient = {
      stream: mock.fn(async (_request: OaiChatRequest, cb: StreamCallbacks) => {
        cb.onTextDelta('hello ')
        cb.onThinkingDelta('thinking')
        cb.onContentBlock({ type: 'text', text: 'hello ' })
        cb.onContentBlock({ type: 'tool_use', id: 'tu_1', name: 'read_file', input: { file_path: '/tmp/a.ts' } })
        cb.onStopReason('tool_use', {
          input_tokens: 100,
          output_tokens: 20,
          cache_read_input_tokens: 70,
          cache_creation_input_tokens: 30,
        })
      }),
    }
    const { controller, getStreamedText, usage, turnCaches } = makeController(client)
    const texts: string[] = []
    const thinking: string[] = []
    const tools: string[] = []

    const result = await controller.streamTurn({
      request,
      turn: 3,
      lastTurnTextFingerprint: '',
      callbacks: {
        onTextDelta: text => { texts.push(text) },
        onThinkingDelta: value => { thinking.push(value) },
        onToolUse: (_id, name) => { tools.push(name) },
        onError: () => {},
      },
    })

    assert.equal(getStreamedText(), 'hello ')
    assert.deepEqual(texts, ['hello '])
    assert.deepEqual(thinking, ['thinking'])
    assert.deepEqual(tools, ['read_file'])
    assert.equal(result.stopReason, 'tool_use')
    assert.equal(result.toolUses[0]?.id, 'tu_1')
    assert.equal(result.collectedBlocks.length, 2)
    assert.equal(usage.length, 1)
    assert.equal(turnCaches[0]?.turn, 3)
    assert.equal(turnCaches[0]?.usage.cache_read_input_tokens, 70)
  })

  it('deduplicates repeated display text against the previous turn fingerprint', async () => {
    const client: StreamClient = {
      stream: mock.fn(async (_request: OaiChatRequest, cb: StreamCallbacks) => {
        cb.onTextDelta('same text')
        cb.onStopReason('end_turn', {})
      }),
    }
    const { controller } = makeController(client)
    const texts: string[] = []

    const result = await controller.streamTurn({
      request,
      turn: 1,
      lastTurnTextFingerprint: 'same text',
      callbacks: {
        onTextDelta: text => { texts.push(text) },
        onThinkingDelta: () => {},
        onToolUse: () => {},
        onError: () => {},
      },
    })

    assert.deepEqual(texts, [])
    assert.equal(result.lastTurnTextFingerprint, 'same text')
  })

  it('records stream errors and estimates output usage from partial content', async () => {
    const expected = new Error('stream failed')
    const client: StreamClient = {
      stream: mock.fn(async (_request: OaiChatRequest, cb: StreamCallbacks) => {
        cb.onTextDelta('partial')
        cb.onContentBlock({ type: 'text', text: 'partial' })
        throw expected
      }),
    }
    const { controller, usage } = makeController(client)

    const result = await controller.streamTurn({
      request,
      turn: 1,
      lastTurnTextFingerprint: '',
      callbacks: {
        onTextDelta: () => {},
        onThinkingDelta: () => {},
        onToolUse: () => {},
        onError: () => {},
      },
    })

    assert.equal(result.streamError, expected)
    assert.equal(result.collectedBlocks.length, 1)
    assert.equal(usage.at(-1)?.output_tokens, 4)
  })
})
