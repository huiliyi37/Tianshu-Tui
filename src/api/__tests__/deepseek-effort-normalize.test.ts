/**
 * DeepSeek effort 归一化 + thinking 采样字段剥离回归。
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  normalizeDeepSeekChatEffort,
  mapDeepSeekResponsesEffort,
  stripThinkingSamplingFields,
  isDeepSeekEffortProvider,
} from '../deepseek-effort.js'
import { OpenAIClient, type OpenAIClientConfig } from '../openai-client.js'
import type { OaiChatRequest } from '../oai-types.js'

describe('normalizeDeepSeekChatEffort', () => {
  it('maps medium → low (对外可保留 medium)', () => {
    assert.equal(normalizeDeepSeekChatEffort('medium'), 'low')
  })
  it('passes through low/high/max', () => {
    assert.equal(normalizeDeepSeekChatEffort('low'), 'low')
    assert.equal(normalizeDeepSeekChatEffort('high'), 'high')
    assert.equal(normalizeDeepSeekChatEffort('max'), 'max')
  })
  it('maps xhigh → max; off → undefined', () => {
    assert.equal(normalizeDeepSeekChatEffort('xhigh'), 'max')
    assert.equal(normalizeDeepSeekChatEffort('off'), undefined)
  })
})

describe('mapDeepSeekResponsesEffort', () => {
  it('keeps medium as medium on Responses wire', () => {
    assert.equal(mapDeepSeekResponsesEffort('medium'), 'medium')
  })
  it('maps off → none', () => {
    assert.equal(mapDeepSeekResponsesEffort('off'), 'none')
  })
})

describe('stripThinkingSamplingFields', () => {
  it('removes temperature/top_p/penalties', () => {
    const body: Record<string, unknown> = {
      temperature: 0.7,
      top_p: 0.9,
      presence_penalty: 0.1,
      frequency_penalty: 0.2,
      reasoning_effort: 'low',
    }
    stripThinkingSamplingFields(body)
    assert.equal(body.temperature, undefined)
    assert.equal(body.top_p, undefined)
    assert.equal(body.presence_penalty, undefined)
    assert.equal(body.frequency_penalty, undefined)
    assert.equal(body.reasoning_effort, 'low')
  })
})

describe('isDeepSeekEffortProvider', () => {
  it('matches deepseek and siliconflow', () => {
    assert.equal(isDeepSeekEffortProvider('deepseek'), true)
    assert.equal(isDeepSeekEffortProvider('siliconflow'), true)
    assert.equal(isDeepSeekEffortProvider('glm'), false)
  })
})

const DEEPSEEK_CONFIG: OpenAIClientConfig = {
  baseUrl: 'https://api.deepseek.com',
  apiKey: 'sk-test',
  model: 'deepseek-v4-flash',
  maxTokens: 8192,
  providerName: 'deepseek',
  thinking: 'enabled',
  thinkingFormat: 'anthropic',
  effortFormat: 'reasoning_effort',
  reasoningEffort: 'medium',
}

async function captureBody(config: OpenAIClientConfig, request: OaiChatRequest): Promise<Record<string, unknown>> {
  const orig = globalThis.fetch
  let captured: Record<string, unknown> = {}
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    captured = JSON.parse(init.body as string)
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'))
        controller.close()
      },
    })
    return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } })
  }) as unknown as typeof fetch
  try {
    const client = new OpenAIClient(config)
    const noop: import('../stream-client.js').StreamCallbacks = {
      onTextDelta: () => {},
      onThinkingDelta: () => {},
      onContentBlock: () => {},
      onStopReason: () => {},
      onError: () => {},
    }
    await client.stream(request, noop)
  } finally {
    globalThis.fetch = orig
  }
  return captured
}

describe('openai-client DeepSeek wire contracts', () => {
  it('normalizes medium → low on wire', async () => {
    const body = await captureBody(DEEPSEEK_CONFIG, {
      model: 'deepseek-v4-flash',
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 8192,
    })
    assert.equal(body.reasoning_effort, 'low')
    assert.deepEqual(body.thinking, { type: 'enabled' })
  })

  it('strips temperature when thinking enabled (body 无 temperature)', async () => {
    const body = await captureBody(DEEPSEEK_CONFIG, {
      model: 'deepseek-v4-flash',
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 8192,
      temperature: 0.7,
    })
    assert.equal('temperature' in body, false, 'thinking 开启时 body 不得含 temperature')
    assert.equal(body.reasoning_effort, 'low')
  })

  it('keeps max as max on Flash wire', async () => {
    const body = await captureBody(
      { ...DEEPSEEK_CONFIG, reasoningEffort: 'max' },
      { model: 'deepseek-v4-flash', messages: [{ role: 'user', content: 'hi' }], max_tokens: 8192 },
    )
    assert.equal(body.reasoning_effort, 'max')
  })
})
