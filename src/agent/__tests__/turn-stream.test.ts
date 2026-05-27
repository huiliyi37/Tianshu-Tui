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

  it('pushes text deltas in real-time during stream', async () => {
    let callbacksDuringStream: string[] = []
    const client: StreamClient = {
      stream: mock.fn(async (_request: OaiChatRequest, cb: StreamCallbacks) => {
        cb.onTextDelta('first ')
        cb.onTextDelta('second')
        callbacksDuringStream = [...observedCallbacks]
        cb.onStopReason('end_turn', {})
      }),
    }
    const { controller, getStreamedText } = makeController(client)
    const observedCallbacks: string[] = []

    await controller.streamTurn({
      request,
      turn: 1,
      lastTurnTextFingerprint: '',
      callbacks: {
        onTextDelta: text => { observedCallbacks.push(text) },
        onThinkingDelta: () => {},
        onToolUse: () => {},
        onError: () => {},
      },
    })

    assert.equal(getStreamedText(), 'first second')
    assert.deepEqual(callbacksDuringStream, ['first ', 'second'])
    assert.deepEqual(observedCallbacks, ['first ', 'second'])
  })

  it('computes fingerprint for cross-turn dedup', async () => {
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

    // Real-time push happens regardless of fingerprint
    assert.deepEqual(texts, ['same text'])
    // Fingerprint is still computed for next turn's use
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

  it('suppresses consecutive duplicate chunks (≥50 chars)', async () => {
    const longChunk = 'a'.repeat(60)
    const client: StreamClient = {
      stream: mock.fn(async (_request: OaiChatRequest, cb: StreamCallbacks) => {
        cb.onTextDelta(longChunk)
        cb.onTextDelta(longChunk) // consecutive duplicate
        cb.onTextDelta(longChunk) // triple
        cb.onTextDelta('short')
        cb.onStopReason('end_turn', {})
      }),
    }
    const { controller } = makeController(client)
    const texts: string[] = []

    await controller.streamTurn({
      request,
      turn: 1,
      lastTurnTextFingerprint: '',
      callbacks: {
        onTextDelta: text => { texts.push(text) },
        onThinkingDelta: () => {},
        onToolUse: () => {},
        onError: () => {},
      },
    })

    assert.deepEqual(texts, [longChunk, 'short'])
  })

  it('suppresses non-consecutive duplicate chunks (≥50 chars)', async () => {
    const longA = 'This is chunk A with enough length to exceed fifty character threshold!'
    const longB = 'Completely different chunk B that also exceeds the fifty char limit!!'
    const client: StreamClient = {
      stream: mock.fn(async (_request: OaiChatRequest, cb: StreamCallbacks) => {
        cb.onTextDelta(longA)
        cb.onTextDelta(longB)
        cb.onTextDelta(longA) // non-consecutive duplicate of chunk A
        cb.onStopReason('end_turn', {})
      }),
    }
    const { controller } = makeController(client)
    const texts: string[] = []

    await controller.streamTurn({
      request,
      turn: 1,
      lastTurnTextFingerprint: '',
      callbacks: {
        onTextDelta: text => { texts.push(text) },
        onThinkingDelta: () => {},
        onToolUse: () => {},
        onError: () => {},
      },
    })

    assert.deepEqual(texts, [longA, longB])
  })

  it('passes through short duplicate chunks (<50 chars)', async () => {
    const shortChunk = 'hello world'
    const client: StreamClient = {
      stream: mock.fn(async (_request: OaiChatRequest, cb: StreamCallbacks) => {
        cb.onTextDelta(shortChunk)
        cb.onTextDelta(shortChunk) // duplicate but short — should pass
        cb.onStopReason('end_turn', {})
      }),
    }
    const { controller } = makeController(client)
    const texts: string[] = []

    await controller.streamTurn({
      request,
      turn: 1,
      lastTurnTextFingerprint: '',
      callbacks: {
        onTextDelta: text => { texts.push(text) },
        onThinkingDelta: () => {},
        onToolUse: () => {},
        onError: () => {},
      },
    })

    // Short chunks are never deduped — only 50+ char chunks are
    assert.deepEqual(texts, [shortChunk, shortChunk])
  })

  it('delivers partial text deltas before mid-stream error', async () => {
    const expected = new Error('connection reset')
    const client: StreamClient = {
      stream: mock.fn(async (_request: OaiChatRequest, cb: StreamCallbacks) => {
        cb.onTextDelta('Hello ')
        cb.onTextDelta('world')
        cb.onTextDelta(' this is partial')
        // Stream dies mid-way — no onStopReason, no clean end
        cb.onContentBlock({ type: 'text', text: 'Hello world this is partial' })
        throw expected
      }),
    }
    const { controller } = makeController(client)
    const texts: string[] = []

    const result = await controller.streamTurn({
      request,
      turn: 1,
      lastTurnTextFingerprint: '',
      callbacks: {
        onTextDelta: text => { texts.push(text) },
        onThinkingDelta: () => {},
        onToolUse: () => {},
        onError: () => {},
      },
    })

    // All deltas pushed before the error are received by the callback
    assert.deepEqual(texts, ['Hello ', 'world', ' this is partial'])
    // Error is still recorded
    assert.equal(result.streamError, expected)
    // Blocks collected before error are preserved
    assert.equal(result.collectedBlocks.length, 1)
    // Fingerprint is computed from partial buffer for next turn's cross-turn dedup
    assert.equal(result.lastTurnTextFingerprint, 'Hello world this is partial')
  })

  it('propagates fingerprint across two turns for cross-turn dedup', async () => {
    const identicalText = 'I will analyze the code for you.'
    let callCount = 0
    const client: StreamClient = {
      stream: mock.fn(async (_request: OaiChatRequest, cb: StreamCallbacks) => {
        callCount++
        cb.onTextDelta(identicalText)
        cb.onContentBlock({ type: 'text', text: identicalText })
        cb.onStopReason('end_turn', {})
      }),
    }
    const { controller } = makeController(client)
    const turn1Texts: string[] = []
    const turn2Texts: string[] = []

    // Turn 1: normal output, computes fingerprint
    const result1 = await controller.streamTurn({
      request,
      turn: 1,
      lastTurnTextFingerprint: '',
      callbacks: {
        onTextDelta: text => { turn1Texts.push(text) },
        onThinkingDelta: () => {},
        onToolUse: () => {},
        onError: () => {},
      },
    })
    assert.deepEqual(turn1Texts, [identicalText])
    assert.equal(result1.lastTurnTextFingerprint, identicalText)

    // Turn 2: model retries with identical text — TurnStreamController pushes in real-time,
    // but the fingerprint matches. The caller (AgentLoop three-state machine) uses this
    // to suppress. Here we verify fingerprint propagation, not suppression.
    const result2 = await controller.streamTurn({
      request,
      turn: 2,
      lastTurnTextFingerprint: result1.lastTurnTextFingerprint,
      callbacks: {
        onTextDelta: text => { turn2Texts.push(text) },
        onThinkingDelta: () => {},
        onToolUse: () => {},
        onError: () => {},
      },
    })
    // TurnStreamController pushes real-time regardless — suppression is AgentLoop's job
    assert.deepEqual(turn2Texts, [identicalText])
    // But the fingerprint is identical, enabling the caller to detect the retry
    assert.equal(result2.lastTurnTextFingerprint, identicalText)
    assert.equal(callCount, 2)
  })
})
