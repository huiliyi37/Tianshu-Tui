/**
 * DeepSeek thinking-mode 请求体契约测试。
 *
 * 官方文档 (https://api-docs.deepseek.com/zh-cn/guides/thinking_mode) curl 样例：
 *   { "model": "deepseek-v4-pro", "thinking": {"type":"enabled"}, "reasoning_effort": "high" }
 * 即思考模式下 thinking 块与 reasoning_effort **并存**，effort 控制思考强度
 * (high 默认 / max)。
 *
 * BUG（修复前）：openai-client 的 thinking dispatch 对 usesThinkingBlock 提供商
 * (DeepSeek thinkingFormat='anthropic') 只发 body.thinking，**漏发 reasoning_effort**
 * —— 配置的 reasoningEffort='max' 被静默丢弃，DeepSeek 退回服务端默认 effort。
 * reasoning_effort 仅在 else 分支(纯 OpenAI)或 request.reasoning_effort 存在时才发，
 * 而 buildOaiRequest 从不填 request.reasoning_effort。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { OpenAIClient, type OpenAIClientConfig } from '../openai-client.js'
import type { OaiChatRequest } from '../oai-types.js'

const DEEPSEEK_CONFIG: OpenAIClientConfig = {
  baseUrl: 'https://api.deepseek.com',
  apiKey: 'sk-test',
  model: 'deepseek-v4-pro',
  maxTokens: 8192,
  providerName: 'deepseek',
  thinking: 'enabled',
  thinkingFormat: 'anthropic',
  effortFormat: 'reasoning_effort',
  reasoningEffort: 'max',
}

// 捕获 stream() 实际发出的请求体（mock fetch 返回一个立即结束的 SSE 流）。
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

const baseRequest: OaiChatRequest = {
  model: 'deepseek-v4-pro',
  messages: [{ role: 'user', content: 'hi' }],
  max_tokens: 8192,
}

test('DeepSeek thinking 模式：thinking 块与 reasoning_effort 必须并存', async () => {
  const body = await captureBody(DEEPSEEK_CONFIG, baseRequest)

  // thinking 块正确（这部分修复前就对）
  assert.deepEqual(body.thinking, { type: 'enabled' }, 'thinking 块应为 {type:enabled}')

  // 核心契约：配置 reasoningEffort='max' 必须落到线上 body.reasoning_effort
  assert.equal(
    body.reasoning_effort,
    'max',
    `reasoning_effort 应为 'max'（配置值），实际=${JSON.stringify(body.reasoning_effort)} —— 漏发会让 DeepSeek 退回默认 effort`,
  )
})

test('DeepSeek thinking disabled：不发 thinking 块也不发 reasoning_effort', async () => {
  const body = await captureBody(
    { ...DEEPSEEK_CONFIG, thinking: 'disabled' },
    baseRequest,
  )
  assert.equal(body.thinking, undefined, 'disabled 时不应发 thinking 块')
  assert.equal(body.reasoning_effort, undefined, 'disabled 时不应发 reasoning_effort')
})

test('DeepSeek tool-call assistant without reasoning gets empty reasoning_content on wire', async () => {
  const body = await captureBody(DEEPSEEK_CONFIG, {
    ...baseRequest,
    messages: [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'go' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{}' } }],
      },
    ],
  })
  const asst = (body.messages as Array<Record<string, unknown>>).find(m => m.role === 'assistant')
  assert.ok(asst, 'assistant message present')
  assert.ok('reasoning_content' in asst!, 'tool-call turn must include reasoning_content field')
  assert.equal(asst!.reasoning_content, '')
})

test('DeepSeek tool-call assistant with reasoning preserves content on wire', async () => {
  const body = await captureBody(DEEPSEEK_CONFIG, {
    ...baseRequest,
    messages: [
      { role: 'user', content: 'go' },
      {
        role: 'assistant',
        content: '',
        reasoning_content: 'planning read',
        tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{}' } }],
      },
    ],
  })
  const asst = (body.messages as Array<Record<string, unknown>>).find(m => m.role === 'assistant')
  assert.equal(asst!.reasoning_content, 'planning read')
})
