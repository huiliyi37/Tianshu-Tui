# Multi-Provider Phase 2: OpenAIClient 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 实现 OpenAIClient，让 Rivet 支持 OpenAI 协议 provider（GPT-4o、o3 等）。

**架构：** 新 `OpenAIClient` 类实现 `StreamClient` 接口，与现有 `ApiClient` 同级。Factory 根据 `protocol: 'openai'` 创建对应 client。消息格式转换（`ContentBlock[]` ←→ OpenAI messages）和 SSE 流解析（OpenAI delta → `StreamCallbacks`）在 client 内部闭环。分两阶段交付：Phase 2a = text-only，Phase 2b = tool_calls。

**技术栈：** TypeScript, node:test, existing StreamClient/SSEParser infrastructure.

**前置条件：** 设计文档 `docs/superpowers/specs/2026-05-17-multi-provider-integration-design.md` 中 Phase 2 部分已审批。

**验收标准：**
| 标准 | 验证方法 |
|------|---------|
| OpenAIClient 实现 StreamClient 接口 | `npm run typecheck` 通过 |
| Text-only GPT 对话可以工作 | 单元测试：发送 text-only request，验证 SSE 解析正确 |
| OpenAI SSE 流正确解析为 StreamCallbacks | 单元测试：mock SSE event stream → 验证 onTextDelta/onStopReason 调用 |
| Tool calls 增量缓冲正确 | 单元测试：分片 tool_calls delta → 验证完整 tool_use 输出 |
| Factory 为 openai protocol 创建 OpenAIClient | 单元测试 |
| 向后兼容：antropic protocol 仍然创建 ApiClient | 单元测试 |
| 现有测试全部通过 | `npm test` |

---

## 文件结构

### 新建文件

| 文件 | 职责 |
|------|------|
| `src/api/openai-client.ts` | OpenAIClient 类：消息转换 + SSE 解析 + tool_calls 缓冲 |
| `src/api/__tests__/openai-client.test.ts` | OpenAIClient 单元测试 |

### 修改文件

| 文件 | 变更 |
|------|------|
| `src/api/factory.ts` | `createProviderClient` 中 openai 分支创建 `OpenAIClient` 而非 throw |

### Schema 与 provider defaults

`src/config/schema.ts` 和 `src/api/provider.ts` 中的 `protocol: 'openai'` 字段和 `WELL_KNOWN_DEFAULTS.openai` 已在 Phase 1 就绪，无需改动。

---

## 任务 1：OpenAIClient 骨架 + 消息格式转换

**文件：**
- 创建：`src/api/openai-client.ts`
- 创建：`src/api/__tests__/openai-client.test.ts`

OpenAI 请求格式：
```json
{
  "model": "gpt-4o",
  "messages": [
    {"role": "system", "content": "You are a helpful assistant"},
    {"role": "user", "content": "Hello"},
    {"role": "assistant", "content": "Hi!"},
    {"role": "user", "content": [
      {"type": "text", "text": "describe this image"},
      {"type": "image_url", "image_url": {"url": "data:image/png;base64,..."}}
    ]},
    {"role": "assistant", "content": null, "tool_calls": [...]},
    {"role": "tool", "tool_call_id": "call_xxx", "content": "result"}
  ],
  "max_tokens": 4096,
  "stream": true
}
```

Anthropic → OpenAI 消息映射规则：
- `role === 'user'` → `role: 'user'` — 不变的 ContentBlock[]
- `role === 'assistant'` → `role: 'assistant'` — text blocks 合并为 content，tool_use blocks → tool_calls
- `role === 'tool_result'` → `role: 'tool'` — tool_result 放在 user message 中 Anthropic 格式，需要在 messages 中作为独立 tool 消息提取
- `system` → 作为首条 `role: 'system'` 消息注入 messages 顶部

- [ ] **步骤 1：编写 OpenAIClient 类骨架的测试**

创建 `src/api/__tests__/openai-client.test.ts`：

```typescript
import { describe, it, before, after, mock } from 'node:test'
import assert from 'node:assert/strict'
import { OpenAIClient, type OpenAIClientConfig } from '../openai-client.js'
import type { MessageRequest, ContentBlock } from '../types.js'
import type { StreamCallbacks } from '../client.js'

const TEST_CONFIG: OpenAIClientConfig = {
  baseUrl: 'https://api.openai.com/v1',
  apiKey: 'sk-test',
  model: 'gpt-4o',
  maxTokens: 4096,
}

function makeRequest(text: string): MessageRequest {
  return {
    messages: [
      { role: 'user', content: [{ type: 'text', text }] },
    ],
    system: 'You are a helpful assistant.',
    maxTokens: 4096,
  }
}

describe('OpenAIClient', () => {
  it('implements StreamClient interface', () => {
    const client = new OpenAIClient(TEST_CONFIG)
    assert.equal(typeof client.stream, 'function')
    assert.equal(client.stream.length, 3) // (request, callbacks, signal?)
  })

  it('buildRequestBody produces valid OpenAI request body', () => {
    const client = new OpenAIClient(TEST_CONFIG)
    // Access private method via bracket notation for testing
    const body = (client as any).buildRequestBody(makeRequest('Hello'))
    assert.equal(body.model, 'gpt-4o')
    assert.equal(body.stream, true)
    assert.equal(body.max_tokens, 4096)
    assert.equal(body.messages.length, 2)
    assert.equal(body.messages[0].role, 'system')
    assert.equal(body.messages[0].content, 'You are a helpful assistant.')
    assert.equal(body.messages[1].role, 'user')
    assert.equal(body.messages[1].content, 'Hello')
  })

  it('converts assistant tool_use blocks to tool_calls format', () => {
    const client = new OpenAIClient(TEST_CONFIG)
    const request: MessageRequest = {
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'What time is it?' }] },
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'Let me check' },
            { type: 'tool_use', id: 'tu_1', name: 'get_time', input: { tz: 'UTC' } },
          ],
        },
      ],
      maxTokens: 4096,
    }
    const body = (client as any).buildRequestBody(request)
    const assistantMsg = body.messages.find((m: any) => m.role === 'assistant')
    assert.ok(assistantMsg)
    assert.equal(assistantMsg.content, 'Let me check')
    assert.equal(assistantMsg.tool_calls.length, 1)
    assert.equal(assistantMsg.tool_calls[0].id, 'tu_1')
    assert.equal(assistantMsg.tool_calls[0].function.name, 'get_time')
    assert.equal(assistantMsg.tool_calls[0].function.arguments, '{"tz":"UTC"}')
  })

  it('converts tool_result to OpenAI tool role message', () => {
    const client = new OpenAIClient(TEST_CONFIG)
    const request: MessageRequest = {
      messages: [
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'tu_1', content: [{ type: 'text', text: '12:00 UTC' }] },
            { type: 'text', text: 'Thanks' },
          ],
        },
        { role: 'assistant', content: [{ type: 'text', text: 'Youre welcome' }] },
      ],
      maxTokens: 4096,
    }
    const body = (client as any).buildRequestBody(request)
    // tool_result should be extracted out of user message and become standalone tool message
    const toolMsg = body.messages.find((m: any) => m.role === 'tool')
    assert.ok(toolMsg, 'tool_result should become a tool-role message')
    assert.equal(toolMsg.tool_call_id, 'tu_1')
    assert.equal(toolMsg.content, '12:00 UTC')
    // The user message should only contain the text part, tool_result removed
    const userMsg = body.messages.find((m: any) => m.role === 'user')
    assert.ok(userMsg)
    assert.equal(userMsg.content, 'Thanks')
  })

  it('includes only supported content types in user messages', () => {
    const client = new OpenAIClient(TEST_CONFIG)
    const request: MessageRequest = {
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Hello' },
            { type: 'tool_result', tool_use_id: 'tu_1', content: [{ type: 'text', text: 'result' }] },
            { type: 'text', text: ' world' },
          ],
        },
      ],
      maxTokens: 4096,
    }
    const body = (client as any).buildRequestBody(request)
    // user message should contain only text, tool_result extracted out
    const userMsg = body.messages.find((m: any) => m.role === 'user')
    assert.ok(userMsg)
    assert.equal(userMsg.content, 'Hello world')
  })
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npm test -- src/api/__tests__/openai-client.test.ts`
预期：FAIL（`openai-client.ts` 不存在）

- [ ] **步骤 3：创建 OpenAIClient 骨架**

创建 `src/api/openai-client.ts`：

```typescript
import type { StreamClient } from './stream-client.js'
import type { MessageRequest, ContentBlock } from './types.js'
import type { StreamCallbacks } from './client.js'

export interface OpenAIClientConfig {
  baseUrl: string
  apiKey: string
  model: string
  maxTokens: number
}

interface OpenAIToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

interface ToolCallChunk {
  id?: string
  type?: string
  function?: { name?: string; arguments: string }
}

export class OpenAIClient implements StreamClient {
  private toolCallBuffer = new Map<number, ToolCallChunk>()

  constructor(private config: OpenAIClientConfig) {}

  async stream(
    request: MessageRequest,
    callbacks: StreamCallbacks,
    signal?: AbortSignal,
  ): Promise<void> {
    const body = this.buildRequestBody(request)
    const response = await fetch(`${this.config.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.config.apiKey}`,
      },
      body: JSON.stringify(body),
      signal,
    })

    if (!response.ok) {
      const errorBody = await response.text().catch(() => '')
      const msg = parseOpenAIError(response.status, errorBody)
      throw new Error(msg)
    }

    const reader = response.body?.getReader()
    if (!reader) throw new Error('Response body is not readable')

    await this.parseStream(reader, callbacks, signal)
  }

  /** Exposed for testing */
  buildRequestBody(request: MessageRequest): Record<string, unknown> {
    const messages: Record<string, unknown>[] = []

    if (request.system) {
      messages.push({ role: 'system', content: request.system })
    }

    let pendingToolResult: { toolCallId: string; content: string } | null = null

    for (const msg of request.messages) {
      if (msg.role === 'user') {
        const textParts: string[] = []
        for (const block of msg.content) {
          if (block.type === 'text') {
            textParts.push(block.text)
          } else if (block.type === 'tool_result') {
            pendingToolResult = {
              toolCallId: block.tool_use_id,
              content: extractTextFromResultBlock(block),
            }
          }
          // image blocks pass through as-is
        }
        if (textParts.length > 0) {
          messages.push({ role: 'user', content: textParts.join('') })
        }
        if (pendingToolResult) {
          messages.push({
            role: 'tool',
            tool_call_id: pendingToolResult.toolCallId,
            content: pendingToolResult.content,
          })
          pendingToolResult = null
        }
      } else if (msg.role === 'assistant') {
        const textParts: string[] = []
        const toolCalls: OpenAIToolCall[] = []
        for (const block of msg.content) {
          if (block.type === 'text') {
            textParts.push(block.text)
          } else if (block.type === 'tool_use') {
            toolCalls.push({
              id: block.id,
              type: 'function',
              function: {
                name: block.name,
                arguments: JSON.stringify(block.input),
              },
            })
          }
        }
        const assistant: Record<string, unknown> = { role: 'assistant' }
        if (textParts.length > 0) {
          assistant.content = textParts.join('')
        }
        if (toolCalls.length > 0) {
          assistant.tool_calls = toolCalls
        }
        messages.push(assistant)
      }
    }

    return {
      model: this.config.model,
      messages,
      max_tokens: this.config.maxTokens,
      stream: true,
    }
  }

  private async parseStream(
    reader: ReadableStreamDefaultReader<Uint8Array>,
    callbacks: StreamCallbacks,
    signal?: AbortSignal,
  ): Promise<void> {
    const decoder = new TextDecoder()
    let buffer = ''

    while (true) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')

      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''

      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed || !trimmed.startsWith('data: ')) continue

        const payload = trimmed.slice(6)
        if (payload === '[DONE]') return

        try {
          const parsed = JSON.parse(payload)
          this.processDelta(parsed, callbacks)
        } catch {
          // Skip malformed SSE lines
        }
      }
    }

    // Flush remaining tool calls
    this.flushToolCalls(callbacks)
  }

  /** Exposed for testing: process a single SSE delta chunk */
  processDelta(
    chunk: {
      choices: Array<{
        delta: { content?: string; tool_calls?: Array<ToolCallChunk> }
        finish_reason?: string | null
      }>
    },
    callbacks: StreamCallbacks,
  ): void {
    const choice = chunk.choices?.[0]
    if (!choice) return

    const delta = choice.delta

    if (delta.content) {
      callbacks.onTextDelta?.(delta.content)
    }

    if (delta.tool_calls) {
      for (const tc of delta.tool_calls) {
        const buf = this.toolCallBuffer.get(tc.index ?? 0) ?? { function: { arguments: '' } }
        if (tc.id) buf.id = tc.id
        if (tc.type) buf.type = tc.type
        if (tc.function?.name) {
          buf.function = buf.function ?? { arguments: '' }
          buf.function.name = (buf.function.name ?? '') + tc.function.name
        }
        if (tc.function?.arguments) {
          buf.function = buf.function ?? { arguments: '' }
          buf.function.arguments += tc.function.arguments
        }
        this.toolCallBuffer.set(tc.index ?? 0, buf)
      }
    }

    if (choice.finish_reason) {
      this.flushToolCalls(callbacks)
      callbacks.onStopReason?.(mapFinishReason(choice.finish_reason))
    }
  }

  private flushToolCalls(callbacks: StreamCallbacks): void {
    for (const [, buf] of this.toolCallBuffer) {
      if (!buf.id || !buf.function?.name) continue
      let input: Record<string, unknown> = {}
      try {
        input = JSON.parse(buf.function.arguments)
      } catch {
        input = {}
      }
      callbacks.onContentBlock?.('tool_use', {
        type: 'tool_use',
        id: buf.id,
        name: buf.function.name,
        input,
      })
    }
    this.toolCallBuffer.clear()
  }
}

function mapFinishReason(reason: string): 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence' {
  switch (reason) {
    case 'stop': return 'end_turn'
    case 'tool_calls': return 'tool_use'
    case 'length': return 'max_tokens'
    default: return 'end_turn'
  }
}

function extractTextFromResultBlock(
  block: ContentBlock & { type: 'tool_result' },
): string {
  const textBlocks = block.content.filter((c): c is { type: 'text'; text: string } => c.type === 'text')
  return textBlocks.map(c => c.text).join('')
}

export function parseOpenAIError(status: number, body: string): string {
  try {
    const parsed = JSON.parse(body)
    const code = parsed.error?.code ?? parsed.error?.type ?? `HTTP ${status}`
    const message = parsed.error?.message ?? body
    return `OpenAI API error (${code}): ${message}`
  } catch {
    return `OpenAI API error (HTTP ${status}): ${body}`
  }
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`npm test -- src/api/__tests__/openai-client.test.ts`
预期：PASS

- [ ] **步骤 5：运行 typecheck + 全部测试**

运行：`npm run typecheck && npm test`
预期：无类型错误，全部测试通过

- [ ] **步骤 6：Commit**

```bash
git add src/api/openai-client.ts src/api/__tests__/openai-client.test.ts
git commit -m "feat(api): add OpenAIClient with message format conversion and SSE parsing"
```

---

## 任务 2：OpenAI SSE 流解析（text-only）

**文件：**
- 修改：`src/api/openai-client.ts`
- 修改：`src/api/__tests__/openai-client.test.ts`

SSE 事件示例：
```
data: {"choices":[{"delta":{"role":"assistant","content":""},"index":0}],"created":...}

data: {"choices":[{"delta":{"content":"Hello"},"index":0}],"created":...}

data: {"choices":[{"delta":{"content":" world"},"index":0,"finish_reason":"stop"}],"created":...}

data: [DONE]
```

- [ ] **步骤 1：编写 SSE 解析测试**

在 `src/api/__tests__/openai-client.test.ts` 的 `describe('OpenAIClient')` 中添加：

```typescript
describe('parseStream / SSE parsing', () => {
  it('parses text deltas and stop reason', async () => {
    const client = new OpenAIClient(TEST_CONFIG)

    // Mock an SSE stream that produces a response object
    // with a readable body
    const encoder = new TextEncoder()
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"role":"assistant","content":""},"index":0}]}\n\n'))
        controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"Hello"},"index":0}]}\n\n'))
        controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":" world"},"index":0,"finish_reason":"stop"}]}\n\n'))
        controller.enqueue(encoder.encode('data: [DONE]\n\n'))
        controller.close()
      },
    })

    const response = new Response(stream)

    const textParts: string[] = []
    let stopReason: string | undefined

    await (client as any).parseStreamFromReader(
      response.body!.getReader(),
      {
        onTextDelta: (text) => textParts.push(text),
        onStopReason: (reason) => { stopReason = reason },
      },
    )

    assert.equal(textParts.join(''), 'Hello world')
    assert.equal(stopReason, 'end_turn')
  })

  it('handles empty stream', async () => {
    const client = new OpenAIClient(TEST_CONFIG)
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'))
        controller.close()
      },
    })
    const response = new Response(stream)

    const textParts: string[] = []
    await (client as any).parseStreamFromReader(
      response.body!.getReader(),
      { onTextDelta: (text) => textParts.push(text) },
    )

    assert.equal(textParts.length, 0)
  })
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npm test -- src/api/__tests__/openai-client.test.ts`
预期：FAIL（`parseStreamFromReader` 方法不存在）

- [ ] **步骤 3：提取 parseStream 为可测试方法**

在 `src/api/openai-client.ts` 中添加：

```typescript
  /** Exposed for testing: parse from a reader directly */
  async parseStreamFromReader(
    reader: ReadableStreamDefaultReader<Uint8Array>,
    callbacks: Pick<StreamCallbacks, 'onTextDelta' | 'onContentBlock' | 'onStopReason'>,
    signal?: AbortSignal,
  ): Promise<void> {
    const decoder = new TextDecoder()
    let buffer = ''

    while (true) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')

      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''

      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed || !trimmed.startsWith('data: ')) continue

        const payload = trimmed.slice(6)
        if (payload === '[DONE]') return

        try {
          const parsed = JSON.parse(payload)
          this.processDelta(parsed, callbacks)
        } catch {
          // Skip malformed SSE lines
        }
      }
    }

    this.flushToolCalls(callbacks)
  }
```

更新 `stream()` 方法调用 `parseStreamFromReader` 而非 `parseStream`（或将原有 `parseStream` 重命名为 `parseStreamFromReader`）：

```typescript
  async stream(request, callbacks, signal): Promise<void> {
    // ... fetch ...
    const reader = response.body!.getReader()
    await this.parseStreamFromReader(reader, callbacks, signal)
  }
```

- [ ] **步骤 4：运行测试验证通过**

运行：`npm test -- src/api/__tests__/openai-client.test.ts`
预期：PASS

- [ ] **步骤 5：运行 typecheck + 全部测试**

运行：`npm run typecheck && npm test`
预期：无类型错误，全部测试通过

- [ ] **步骤 6：Commit**

```bash
git add src/api/openai-client.ts src/api/__tests__/openai-client.test.ts
git commit -m "feat(api): OpenAI SSE stream parsing with text deltas and finish_reason"
```

---

## 任务 3：Wire OpenAIClient into Factory

**文件：**
- 修改：`src/api/factory.ts`

- [ ] **步骤 1：修改 factory 创建 OpenAIClient**

在 `src/api/factory.ts` 中将 openai 分支从 throw 改为创建 `OpenAIClient`：

```typescript
import { OpenAIClient } from './openai-client.js'

export function createProviderClient(
  provider: ProviderConfig,
  capabilities: ProviderCapabilities,
  params: RuntimeParams,
): ApiClient | OpenAIClient {
  if (provider.protocol === 'openai') {
    return new OpenAIClient({
      baseUrl: provider.baseUrl,
      apiKey: params.apiKey,
      model: params.model,
      maxTokens: params.maxTokens,
    })
  }

  // ... existing ApiClient path unchanged ...
}
```

注意 `createProviderClient` 的返回类型需要更新为 `ApiClient | OpenAIClient` 或使用 `StreamClient` 接口类型（需要先确认 `StreamClient` 是否已 export）。更简单的方式：返回 `StreamClient`：

```typescript
import type { StreamClient } from './stream-client.js'

export function createProviderClient(
  provider: ProviderConfig,
  capabilities: ProviderCapabilities,
  params: RuntimeParams,
): StreamClient {
```

- [ ] **步骤 2：运行 typecheck**

运行：`npx tsc --noEmit`
预期：无错误（注意：所有消费者已通过 `StreamClient` 接口使用 client，无需改动）

- [ ] **步骤 3：编写 factory 的 openai 分支测试**

在 `src/api/__tests__/factory.test.ts` 中（如果该文件已存在且需要通过其测试）添加：

```typescript
it('creates OpenAIClient for openai protocol', () => {
  const client = createProviderClient(
    {
      name: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      apiKeyEnv: 'OPENAI_API_KEY',
      protocol: 'openai',
      models: [{ id: 'gpt-4o', contextWindow: 128000, maxTokens: 16384 }],
      thinking: 'disabled',
      maxTokens: 16384,
      unsupported: [],
      capabilities: { cacheControl: false, stripParams: [], toolJsonBug: false, prefixCache: 'none' },
      fallback: undefined,
    },
    WELL_KNOWN_DEFAULTS.openai,
    { apiKey: 'sk-test', model: 'gpt-4o', maxTokens: 16384 },
  )

  assert.ok(client instanceof OpenAIClient)
})
```

- [ ] **步骤 4：运行测试验证通过**

运行：`npm test -- src/api/__tests__/factory.test.ts`
预期：PASS

- [ ] **步骤 5：Commit**

```bash
git add src/api/factory.ts
git commit -m "feat(api): wire OpenAIClient into createProviderClient factory"
```

---

## 任务 4：Tool calls 增量缓冲

**文件：**
- 修改：`src/api/openai-client.ts`
- 修改：`src/api/__tests__/openai-client.test.ts`

OpenAI tool_calls 在 SSE 中分片到达。同一个 tool_call 的 id 出现在第一个 chunk，name 在第一个或后续 chunk，arguments 在多个 chunk 中逐步累积：

```
delta: { tool_calls: [{ index: 0, id: "call_abc", type: "function", function: { name: "get_weather", arguments: "" } }] }
delta: { tool_calls: [{ index: 0, function: { arguments: "{\"loc" } }] }
delta: { tool_calls: [{ index: 0, function: { arguments: "ation\": \"NYC\"}" } }] }
finish_reason: "tool_calls"
```

- [ ] **步骤 1：编写 tool_calls 缓冲测试**

在 `src/api/__tests__/openai-client.test.ts` 中添加：

```typescript
describe('tool_calls delta buffering', () => {
  it('accumulates fragmented tool_calls deltas into complete tool_use', () => {
    const client = new OpenAIClient(TEST_CONFIG)

    const contentBlocks: any[] = []
    let stopReason: string | undefined

    // Chunk 1: id + name + empty arguments
    client.processDelta(
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_abc', type: 'function', function: { name: 'get_weather', arguments: '' } }] }, finish_reason: null }] },
      { onContentBlock: (type, block) => contentBlocks.push({ type, block }), onStopReason: (r) => { stopReason = r } },
    )

    // No finish_reason yet — shouldn't emit
    assert.equal(contentBlocks.length, 0)

    // Chunk 2: partial arguments
    client.processDelta(
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"loc' } }] }, finish_reason: null }] },
      { onContentBlock: (type, block) => contentBlocks.push({ type, block }), onStopReason: (r) => { stopReason = r } },
    )

    assert.equal(contentBlocks.length, 0)

    // Chunk 3: remaining arguments + finish_reason
    client.processDelta(
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'ation": "NYC"}' } }] }, finish_reason: 'tool_calls' }] },
      { onContentBlock: (type, block) => contentBlocks.push({ type, block }), onStopReason: (r) => { stopReason = r } },
    )

    assert.equal(contentBlocks.length, 1)
    assert.equal(contentBlocks[0].type, 'tool_use')
    assert.equal(contentBlocks[0].block.id, 'call_abc')
    assert.equal(contentBlocks[0].block.name, 'get_weather')
    assert.deepEqual(contentBlocks[0].block.input, { location: 'NYC' })
    assert.equal(stopReason, 'tool_use')
  })

  it('handles multiple tool calls in one turn', () => {
    const client = new OpenAIClient(TEST_CONFIG)

    const contentBlocks: any[] = []

    // Two tool_calls in a single delta
    client.processDelta(
      {
        choices: [{
          delta: {
            tool_calls: [
              { index: 0, id: 'call_1', type: 'function', function: { name: 'get_time', arguments: '{"tz":"UTC"}' } },
              { index: 1, id: 'call_2', type: 'function', function: { name: 'get_date', arguments: '{"tz":"UTC"}' } },
            ],
          },
          finish_reason: 'tool_calls',
        }],
      },
      { onContentBlock: (type, block) => contentBlocks.push({ type, block }) },
    )

    assert.equal(contentBlocks.length, 2)
    assert.equal(contentBlocks[0].block.name, 'get_time')
    assert.equal(contentBlocks[1].block.name, 'get_date')
  })

  it('handles text content before tool calls', () => {
    const client = new OpenAIClient(TEST_CONFIG)

    const texts: string[] = []
    const contentBlocks: any[] = []

    // Text delta
    client.processDelta(
      { choices: [{ delta: { content: 'Let me check the weather' }, finish_reason: null }] },
      { onTextDelta: (t) => texts.push(t), onContentBlock: (type, block) => contentBlocks.push({ type, block }) },
    )
    assert.equal(texts.join(''), 'Let me check the weather')

    // Tool call delta + finish
    client.processDelta(
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{}' } }] }, finish_reason: 'tool_calls' }] },
      { onTextDelta: (t) => texts.push(t), onContentBlock: (type, block) => contentBlocks.push({ type, block }) },
    )
    assert.equal(contentBlocks.length, 1)
    assert.equal(contentBlocks[0].block.name, 'get_weather')
  })
})
```

- [ ] **步骤 2：运行测试验证通过**

运行：`npm test -- src/api/__tests__/openai-client.test.ts`
预期：PASS（tool_calls 缓冲逻辑已在任务 1 的初始实现中包含，测试验证正确性）

- [ ] **步骤 3：运行全部测试**

运行：`npm test`
预期：全部通过

- [ ] **步骤 4：Commit**

```bash
git add src/api/openai-client.ts src/api/__tests__/openai-client.test.ts
git commit -m "feat(api): tool_calls incremental delta buffering with multi-call support"
```

---

## 任务 5：集成验证 + 错误处理

**文件：**
- 修改：`src/api/openai-client.ts`
- 修改：`src/api/__tests__/openai-client.test.ts`

- [ ] **步骤 1：编写错误处理测试**

在测试文件头部添加 `parseOpenAIError` 导入：

```typescript
import { OpenAIClient, parseOpenAIError } from '../openai-client.js'
```

在 `src/api/__tests__/openai-client.test.ts` 中添加测试：

```typescript
describe('error handling', () => {
  it('formats OpenAI API error with code and message', () => {
    const status = 400
    const body = JSON.stringify({
      error: { code: 'invalid_api_key', message: 'Incorrect API key provided' },
    })
    assert.equal(
      parseOpenAIError(status, body),
      'OpenAI API error (invalid_api_key): Incorrect API key provided',
    )
  })

  it('formats error with type when code is missing', () => {
    const status = 429
    const body = JSON.stringify({
      error: { type: 'rate_limit_error', message: 'Rate limit exceeded' },
    })
    assert.equal(
      parseOpenAIError(status, body),
      'OpenAI API error (rate_limit_error): Rate limit exceeded',
    )
  })

  it('falls back to HTTP status when error body is unparseable', () => {
    assert.equal(
      parseOpenAIError(500, 'Internal Server Error'),
      'OpenAI API error (HTTP 500): Internal Server Error',
    )
  })
})
```

- [ ] **步骤 2：运行测试验证通过**

运行：`npm test -- src/api/__tests__/openai-client.test.ts`
预期：PASS

- [ ] **步骤 3：确认 response.ok 检查在 stream() 方法中正确**

确认 `src/api/openai-client.ts` 中 `stream()` 方法的 fetch 后错误处理已包含完整的 OpenAI 错误解析。确认 `response.body?.getReader()` 失败时抛出有意义的消息。

- [ ] **步骤 4：运行全部测试**

运行：`npm test`
预期：全部通过

- [ ] **步骤 5：最终 typecheck**

运行：`npx tsc --noEmit`
预期：无错误

- [ ] **步骤 6：Commit**

```bash
git add src/api/openai-client.ts src/api/__tests__/openai-client.test.ts
git commit -m "feat(api): OpenAI API error handling with code/type/message parsing"
```

---

## 风险与防线

| 风险 | 应对 |
|------|------|
| `ContentBlock[]` 中 tool_result 与文本混合的顺序处理 | 任务 1 中 `buildRequestBody` 按序扫描 block 提取 tool_result 到独立 tool 消息 |
| 跨线程/跨 agent 的 tool_calls 增量解析状态冲突 | 每个 `stream()` 调用创建独立 `OpenAIClient` 实例，无需共享状态（factory 每次创建新实例） |
| `processDelta` 的 index 参数从 delta 中读取，可能缺失 | 回退到 `tc.index ?? 0` |
| Parse SSE 时 buffer 跨 chunk 边界不完整 | `buffer.split('\n')` 保留末尾片段到下次迭代，正确处理 SSE 事件边界 |
| `parseOpenAIError` 被外部调用方导入 | export 该函数（已在 openai-client.ts 中 export） |

---

## 执行交接

计划已完成并保存到 `docs/superpowers/plans/2026-05-17-multi-provider-phase2.md`。两种执行方式：

**1. 子代理驱动（推荐）** — 每个任务调度新的子代理，任务间进行审查，快速迭代

**2. 内联执行** — 在当前会话中使用 executing-plans 执行任务，批量执行并设有检查点

选哪种方式？
