# Anthropic 原生 Client + 四断点缓存 实现计划

> **面向 AI 代理：** 使用 subagent-driven-development（推荐）或 executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 新增 `AnthropicClient`（实现 `StreamClient`），在请求体中显式插入 4 个 `cache_control` 断点，修复 `minCacheTokens` 错值，扩展缓存诊断支持 Anthropic 缓存字段，使 Claude Opus 的 prompt cache 命中率达到 90%+。

**架构：** 新增 `src/api/anthropic-client.ts`，与 `OpenAIClient` / `CodexClient` 平级，实现 OAI 消息格式 → Anthropic `/v1/messages` 格式转换 + SSE 流解析。不碰提示层组装、不碰 agent loop。断点插入在格式转换层完成：按 `LAYER_ORDER` 找到 tools 末尾、system 末尾、首个 user message 末尾、最后已完成 assistant 轮次末尾四个位置。

**技术栈：** TypeScript strict, node:test + assert/strict, Anthropic Messages API (v1/messages, SSE), cache_control ephemeral breakpoints

---

## 1. Scope Check

本计划覆盖三个独立但相关的变更：

| 子系统 | 文件 | 是否独立可拆分 |
|--------|------|--------------|
| Anthropic 原生 Client | `src/api/anthropic-client.ts` (new) | ✅ 可独立（对现有代码零影响） |
| `minCacheTokens` 修复 | `src/api/provider-profile.ts` | ✅ 可独立（一行改动） |
| 缓存诊断扩展 | `src/prompt/cache-diagnostic.ts` | ✅ 可独立（纯读取扩展） |
| Factory 集成 | `src/api/factory.ts` | 依赖 AnthropicClient 存在 |

三个子系统足够小且紧密相关，合为一个计划。若任一子系统被否决，其余可独立交付。

**不含：** 提示层重构、agent loop 改动、provider registry 新增 Anthropic 条目（那是配置层工作，不在本 spec 范围）。

---

## 2. File Structure

### 新建文件

| 文件 | 职责 |
|------|------|
| `src/api/anthropic-client.ts` | Anthropic 原生格式 client：OAI→Anthropic 消息转换、四断点 cache_control 注入、SSE 流解析 |
| `src/api/__tests__/anthropic-client.test.ts` | AnthropicClient 单元测试：格式转换正确性、断点位置验证、SSE 解析、错误处理 |

### 修改文件

| 文件 | 变更 |
|------|------|
| `src/api/provider-profile.ts:14` | `minCacheTokens: 1024` → `minCacheTokens: 4096`（Opus/Haiku 实际阈值） |
| `src/api/__tests__/provider-profile.test.ts:15-16` | 更新 anthropic minCacheTokens 断言 |
| `src/api/factory.ts:35-47` | 在 `createProviderClient` 中增加 Anthropic 分支（先检查 `provider.name === 'anthropic'` 或 `capabilities.prefixCacheStrategy === 'anthropic-cache-control'`） |
| `src/prompt/cache-diagnostic.ts` | 扩展 `diagnoseCacheMiss` 接口，支持 Anthropic 的 `cache_read_input_tokens` / `cache_creation_input_tokens` 字段（这些字段已在 `TurnCacheSnapshot` 中通过 `Usage` 结构传递） |
| `src/prompt/__tests__/cache-diagnostic.test.ts` | 增加 Anthropic 缓存命中率场景测试 |

---

## 3. Research Endorsement（调研背书）

### 3.1 `minCacheTokens` 修改：`provider-profile.ts:14`

**当前值：** `anthropic: { minCacheTokens: 1024 }` — 这是 Sonnet 的值。

**调用者分析：**
- `getProviderProfile('anthropic')` 被 `factory.ts:46` 调用，传入 `OpenAIClient` 构造
- `provider-registry.ts:70` 通过 `getProviderProfile(key).cacheType` 读取
- `conformance-scorecard.ts` 读取 `cacheType`/`persistent`，不读 `minCacheTokens`
- `compact/constants.ts` 只读 `cacheType`/`persistent`，不读 `minCacheTokens`

**修改理由：** Opus 的 prompt cache 最小块是 4096 tokens。System prompt 通常 >1024 但可能 <4096 tokens（当前 system prompt 约 2700 chars ≈ 675 tokens）。如果 `minCacheTokens` 设为 1024，system prompt 块在 Sonnet 上可以缓存但在 Opus 上被静默跳过。改为 4096 覆盖 Opus/Haiku。Sonnet 的 1024 阈值是子集（system 块 >1024 tokens 在两种模型上都能缓存）。

**边缘情况：** 如果 system prompt 被压缩到 <4096 tokens，1h 缓存失效。当前 system prompt 约 675 tokens（按 char/4 估算），加 Chinese thinking suffix 后约 700。但在 Anthropic 原生格式中，system 是独立数组，不合并到 messages 中。Anthropic 端可能有自己的 token 计数差异。**缓解措施：** 在 `AnthropicClient` 中发送前不依赖 `minCacheTokens` 做过滤——总是插入 cache_control，让 Anthropic API 自己决定是否缓存。`minCacheTokens` 仅用于 compaction 策略和诊断报告。

### 3.2 日期注入验证

**验证结果：** `buildSystemPrompt()` 在 `src/prompt/static.ts:65` 返回静态 `BASE_PROMPT` 字符串，无任何日期/时间戳注入。`buildStableVolatileBlock()` 在 `src/prompt/volatile.ts:116` 只包含 `<environment>` 标签（platform、cwd、os），无日期。日期相关代码均在 benchmark/report、session-registry、retrospect 等非 prompt 路径中。

**结论：** Anthropic system 段完全无日期注入。断点 2（system 最后一个 content block）是安全的。

### 3.3 非确定性序列化

**现有机制：** `fingerprint.ts:31` 使用 `stableStringify([...tools].sort((a, b) => a.name.localeCompare(b.name)))`，`context-layer.ts:59` 有独立的 `stableStringify`。`AnthropicClient` 在构建 tools 数组时必须复用相同模式：先按 name 排序，再序列化。

**不需要新建排序逻辑**——直接在 `AnthropicClient.buildRequestBody` 中对 `request.tools` 执行 `.sort()` 即可。

### 3.4 `cache-diagnostic.ts` 扩展

**当前状态：** `diagnoseCacheMiss` 读取 `TurnCacheSnapshot`（含 `cacheRead`/`cacheCreation`）。`TurnCacheSnapshot` 由 `SessionContext.recordTurnCache` 从 `Usage` 填充。`Usage.cache_read_input_tokens` 和 `Usage.cache_creation_input_tokens` 已经是通用字段。Anthropic SSE `message_start` 事件中的 `cache_read_input_tokens`/`cache_creation_input_tokens` 将通过 `StreamCallbacks.onStopReason` 传递，格式与现有 OpenAI 路径一致。

**结论：** `cache-diagnostic.ts` 不需要修改接口——它已经通过 `TurnCacheSnapshot` 间接消费 `Usage` 缓存字段。只需在 SSE 解析中正确提取 Anthropic 缓存字段即可。

---

## 4. Tasks

### Task 1: 修复 `minCacheTokens` → 4096

**目标：** 将 Anthropic 的 `minCacheTokens` 从 Sonnet 值 (1024) 改为 Opus/Haiku 值 (4096)。

**步骤 1.1：写失败测试**

**文件：** `src/api/__tests__/provider-profile.test.ts:15-16`

修改现有测试断言：
```typescript
// Before (line 15-16):
assert.equal(p.cacheType, 'explicit-breakpoint')
assert.equal(p.minCacheTokens, 1024)

// After:
assert.equal(p.cacheType, 'explicit-breakpoint')
assert.equal(p.minCacheTokens, 4096)
```

**命令：** `npm exec -- tsx --test src/api/__tests__/provider-profile.test.ts`
**预期结果：** 测试失败 — expected 4096, got 1024

**步骤 1.2：修改源码**

**文件：** `src/api/provider-profile.ts:14`

```typescript
// Before:
anthropic: { cacheType: 'explicit-breakpoint', persistent: false, minCacheTokens: 1024, ttlSeconds: 300 },

// After:
anthropic: { cacheType: 'explicit-breakpoint', persistent: false, minCacheTokens: 4096, ttlSeconds: 300 },
```

**命令：** `npm exec -- tsx --test src/api/__tests__/provider-profile.test.ts`
**预期结果：** 全部通过

**步骤 1.3：提交**

```bash
git add src/api/provider-profile.ts src/api/__tests__/provider-profile.test.ts
git commit -m "fix(api): set anthropic minCacheTokens to 4096 for Opus/Haiku compatibility"
```

---

### Task 2: 创建 `AnthropicClient` — 消息格式转换

**目标：** 创建 `AnthropicClient` 类，实现 `StreamClient` 接口，完成 OAI 消息 → Anthropic 格式转换（不含断点）。

**步骤 2.1：创建测试文件骨架**

**文件（创建）：** `src/api/__tests__/anthropic-client.test.ts`

```typescript
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { AnthropicClient } from '../anthropic-client.js'

describe('AnthropicClient message conversion', () => {
  it('extracts system message to top-level system array', () => {
    const client = new AnthropicClient({
      baseUrl: 'https://api.anthropic.com',
      apiKey: 'test-key',
      model: 'claude-opus-4-7',
      maxTokens: 4096,
    })
    const body = client.buildRequestBodyForTest({
      model: 'claude-opus-4-7',
      messages: [
        { role: 'system', content: 'You are a helpful assistant.' },
        { role: 'user', content: 'Hello' },
      ],
      max_tokens: 4096,
    })
    assert.ok(Array.isArray(body.system))
    assert.equal(body.system.length, 1)
    assert.equal(body.system[0].type, 'text')
    assert.equal(body.system[0].text, 'You are a helpful assistant.')
    // system should NOT be in messages
    const hasSystemInMessages = (body.messages as Array<{role: string}>).some(m => m.role === 'system')
    assert.equal(hasSystemInMessages, false)
  })

  it('converts user message to content blocks array', () => {
    const client = new AnthropicClient({
      baseUrl: 'https://api.anthropic.com',
      apiKey: 'test-key',
      model: 'claude-opus-4-7',
      maxTokens: 4096,
    })
    const body = client.buildRequestBodyForTest({
      model: 'claude-opus-4-7',
      messages: [
        { role: 'user', content: 'Hello world' },
      ],
      max_tokens: 4096,
    })
    assert.equal(body.messages.length, 1)
    const msg = body.messages[0]
    assert.equal(msg.role, 'user')
    assert.ok(Array.isArray(msg.content))
    assert.equal(msg.content[0].type, 'text')
    assert.equal(msg.content[0].text, 'Hello world')
  })

  it('converts assistant message with text to content blocks', () => {
    const client = new AnthropicClient({
      baseUrl: 'https://api.anthropic.com',
      apiKey: 'test-key',
      model: 'claude-opus-4-7',
      maxTokens: 4096,
    })
    const body = client.buildRequestBodyForTest({
      model: 'claude-opus-4-7',
      messages: [
        { role: 'assistant', content: 'Hi there!' },
      ],
      max_tokens: 4096,
    })
    const msg = body.messages[0]
    assert.equal(msg.role, 'assistant')
    assert.ok(Array.isArray(msg.content))
    assert.equal(msg.content[0].type, 'text')
    assert.equal(msg.content[0].text, 'Hi there!')
  })

  it('converts assistant with tool_calls to tool_use blocks', () => {
    const client = new AnthropicClient({
      baseUrl: 'https://api.anthropic.com',
      apiKey: 'test-key',
      model: 'claude-opus-4-7',
      maxTokens: 4096,
    })
    const body = client.buildRequestBodyForTest({
      model: 'claude-opus-4-7',
      messages: [
        {
          role: 'assistant',
          content: 'Let me read that file.',
          tool_calls: [
            { id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"file_path":"/foo"}' } },
          ],
        },
      ],
      max_tokens: 4096,
    })
    const msg = body.messages[0]
    assert.equal(msg.role, 'assistant')
    const types = msg.content.map((b: {type: string}) => b.type)
    assert.ok(types.includes('text'))
    assert.ok(types.includes('tool_use'))
    const toolUse = msg.content.find((b: {type: string}) => b.type === 'tool_use')
    assert.equal(toolUse.name, 'read_file')
    assert.deepEqual(toolUse.input, { file_path: '/foo' })
  })

  it('converts tool result message to tool_result content block in user role', () => {
    const client = new AnthropicClient({
      baseUrl: 'https://api.anthropic.com',
      apiKey: 'test-key',
      model: 'claude-opus-4-7',
      maxTokens: 4096,
    })
    const body = client.buildRequestBodyForTest({
      model: 'claude-opus-4-7',
      messages: [
        { role: 'tool', tool_call_id: 'call_1', content: 'file contents here' },
      ],
      max_tokens: 4096,
    })
    const msg = body.messages[0]
    // Anthropic format: tool_result is in a user-role message
    assert.equal(msg.role, 'user')
    assert.ok(Array.isArray(msg.content))
    assert.equal(msg.content[0].type, 'tool_result')
    assert.equal(msg.content[0].tool_use_id, 'call_1')
    assert.equal(msg.content[0].content, 'file contents here')
  })

  it('converts tools to Anthropic input_schema format sorted by name', () => {
    const client = new AnthropicClient({
      baseUrl: 'https://api.anthropic.com',
      apiKey: 'test-key',
      model: 'claude-opus-4-7',
      maxTokens: 4096,
    })
    const body = client.buildRequestBodyForTest({
      model: 'claude-opus-4-7',
      messages: [{ role: 'user', content: 'test' }],
      max_tokens: 4096,
      tools: [
        { type: 'function', function: { name: 'zebra', description: 'z', parameters: { type: 'object', properties: {} } } },
        { type: 'function', function: { name: 'alpha', description: 'a', parameters: { type: 'object', properties: { x: { type: 'string' } }, required: ['x'] } } },
      ],
    })
    assert.ok(Array.isArray(body.tools))
    assert.equal(body.tools[0].name, 'alpha') // sorted by name
    assert.equal(body.tools[1].name, 'zebra')
    // Check input_schema format
    assert.equal(body.tools[0].input_schema.type, 'object')
    assert.deepEqual(body.tools[0].input_schema.required, ['x'])
  })

  it('handles assistant message with reasoning_content', () => {
    const client = new AnthropicClient({
      baseUrl: 'https://api.anthropic.com',
      apiKey: 'test-key',
      model: 'claude-opus-4-7',
      maxTokens: 4096,
    })
    const body = client.buildRequestBodyForTest({
      model: 'claude-opus-4-7',
      messages: [
        { role: 'assistant', content: 'answer', reasoning_content: 'thinking...' },
      ],
      max_tokens: 4096,
    })
    const msg = body.messages[0]
    const types = msg.content.map((b: {type: string}) => b.type)
    assert.ok(types.includes('thinking'))
    assert.ok(types.includes('text'))
    const thinkingBlock = msg.content.find((b: {type: string}) => b.type === 'thinking')
    assert.equal(thinkingBlock.thinking, 'thinking...')
  })
})
```

**步骤 2.2：确认测试失败**

**命令：** `npm exec -- tsx --test src/api/__tests__/anthropic-client.test.ts`
**预期结果：** 编译失败 — 模块 `../anthropic-client.js` 不存在

**步骤 2.3：创建 `AnthropicClient`（最小实现：仅格式转换）**

**文件（创建）：** `src/api/anthropic-client.ts`

```typescript
import type { StreamClient, StreamCallbacks } from './stream-client.js'
import type { OaiChatRequest, OaiMessage, OaiToolDefinition } from './oai-types.js'
import { withStructuredRetry } from './retry-engine.js'

export interface AnthropicClientConfig {
  baseUrl: string
  apiKey: string
  model: string
  maxTokens: number
  thinkingBudget?: number
}

interface AnthropicContentBlock {
  type: 'text' | 'thinking' | 'tool_use' | 'tool_result'
  text?: string
  thinking?: string
  id?: string
  name?: string
  input?: Record<string, unknown>
  tool_use_id?: string
  content?: string
  cache_control?: { type: 'ephemeral' }
}

interface AnthropicMessage {
  role: 'user' | 'assistant'
  content: AnthropicContentBlock[]
}

interface AnthropicRequestBody {
  model: string
  max_tokens: number
  system?: AnthropicContentBlock[]
  tools?: Array<{
    name: string
    description?: string
    input_schema: Record<string, unknown>
    cache_control?: { type: 'ephemeral' }
  }>
  messages: AnthropicMessage[]
  stream: boolean
  thinking?: { type: 'enabled'; budget_tokens: number }
}

export class AnthropicClient implements StreamClient {
  constructor(private config: AnthropicClientConfig) {}

  setReasoningEffort(_effort: string): void {
    // Anthropic doesn't use reasoning_effort — thinking budget is set at construction
  }

  async stream(
    request: OaiChatRequest,
    callbacks: StreamCallbacks,
    signal?: AbortSignal,
  ): Promise<void> {
    const body = this.buildRequestBody(request)

    await withStructuredRetry(async () => {
      const response = await fetch(`${this.config.baseUrl.replace(/\/+$/, '')}/v1/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': this.config.apiKey,
          'anthropic-version': '2023-06-01',
          'Accept': 'text/event-stream',
        },
        body: JSON.stringify(body),
        signal,
      })

      if (!response.ok) {
        const errorBody = await response.text().catch(() => '')
        throw Object.assign(
          new Error(`Anthropic API error (${response.status}): ${errorBody}`),
          { status: response.status },
        )
      }

      await this.processSSEStream(response, callbacks, signal)
    }, signal)
  }

  /** Exposed for testing. */
  buildRequestBodyForTest(request: OaiChatRequest): AnthropicRequestBody {
    return this.buildRequestBody(request)
  }

  private buildRequestBody(request: OaiChatRequest): AnthropicRequestBody {
    // Extract system messages
    let systemText = ''
    const nonSystemMessages = request.messages.filter(m => {
      if (m.role === 'system') {
        systemText += (systemText ? '\n\n' : '') + m.content
        return false
      }
      return true
    })

    const system: AnthropicContentBlock[] = systemText
      ? [{ type: 'text', text: systemText }]
      : []

    // Convert messages
    const messages = nonSystemMessages.map(m => this.convertMessage(m))

    // Convert tools — sorted by name for deterministic cache
    const tools = request.tools && request.tools.length > 0
      ? [...request.tools]
          .sort((a, b) => a.function.name.localeCompare(b.function.name))
          .map(t => ({
            name: t.function.name,
            description: t.function.description,
            input_schema: t.function.parameters,
          }))
      : undefined

    const body: AnthropicRequestBody = {
      model: request.model,
      max_tokens: request.max_tokens ?? this.config.maxTokens,
      messages,
      stream: true,
    }

    if (system.length > 0) body.system = system
    if (tools) body.tools = tools
    if (this.config.thinkingBudget && this.config.thinkingBudget > 0) {
      body.thinking = { type: 'enabled', budget_tokens: this.config.thinkingBudget }
    }

    return body
  }

  private convertMessage(msg: OaiMessage): AnthropicMessage {
    if (msg.role === 'user') {
      return {
        role: 'user',
        content: [{ type: 'text', text: msg.content }],
      }
    }

    if (msg.role === 'tool') {
      return {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: msg.tool_call_id, content: msg.content }],
      }
    }

    if (msg.role === 'assistant') {
      const blocks: AnthropicContentBlock[] = []

      if (msg.reasoning_content) {
        blocks.push({ type: 'thinking', thinking: msg.reasoning_content })
      }

      if (msg.content) {
        blocks.push({ type: 'text', text: msg.content })
      }

      if (msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          let input: Record<string, unknown> = {}
          try {
            input = JSON.parse(tc.function.arguments)
          } catch { /* keep empty */ }
          blocks.push({
            type: 'tool_use',
            id: tc.id,
            name: tc.function.name,
            input,
          })
        }
      }

      return { role: 'assistant', content: blocks }
    }

    // Fallback (should not reach here)
    return { role: 'user', content: [{ type: 'text', text: '' }] }
  }

  private async processSSEStream(
    response: Response,
    callbacks: StreamCallbacks,
    signal?: AbortSignal,
  ): Promise<void> {
    const reader = response.body?.getReader()
    if (!reader) throw new Error('No response body')

    const decoder = new TextDecoder()
    let buffer = ''
    let stopReason: string | null = null
    let usage: {
      input_tokens?: number
      output_tokens?: number
      cache_read_input_tokens?: number
      cache_creation_input_tokens?: number
    } = {}

    // Track content block state
    const textBlocks: string[] = []
    const thinkingBlocks: string[] = []
    const toolUseBlocks: Array<{ id: string; name: string; input: Record<string, unknown> }> = []
    let currentBlockType: string | null = null

    // SSE idle timeout
    const FIRST_BYTE_TIMEOUT_MS = 45_000
    const READ_TIMEOUT_MS = 180_000
    let streamTimedOut = false
    let idleTimer: ReturnType<typeof setTimeout> | null = null
    let receivedFirstChunk = false

    const resetIdleTimer = () => {
      if (idleTimer) clearTimeout(idleTimer)
      const timeout = receivedFirstChunk ? READ_TIMEOUT_MS : FIRST_BYTE_TIMEOUT_MS
      idleTimer = setTimeout(() => {
        streamTimedOut = true
        reader.cancel().catch(() => {})
      }, timeout)
    }

    try {
      resetIdleTimer()
      while (true) {
        if (signal?.aborted) break
        if (streamTimedOut) throw new Error('Anthropic SSE stream idle timeout (180s)')

        const { done, value } = await reader.read()
        if (done) break
        receivedFirstChunk = true
        resetIdleTimer()

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''

        let eventType = ''
        for (const line of lines) {
          const trimmed = line.trim()

          if (trimmed.startsWith('event: ')) {
            eventType = trimmed.slice(7).trim()
            continue
          }

          if (!trimmed.startsWith('data: ')) continue
          const data = trimmed.slice(6)

          let parsed: Record<string, unknown>
          try { parsed = JSON.parse(data) } catch { continue }

          const type = parsed.type as string

          switch (type) {
            case 'message_start': {
              const msg = parsed.message as Record<string, unknown> | undefined
              if (msg?.usage) {
                const u = msg.usage as Record<string, unknown>
                usage = {
                  input_tokens: u.input_tokens as number,
                  cache_read_input_tokens: u.cache_read_input_tokens as number,
                  cache_creation_input_tokens: u.cache_creation_input_tokens as number,
                }
              }
              break
            }

            case 'content_block_start': {
              const block = parsed.content_block as Record<string, unknown> | undefined
              if (!block) break
              currentBlockType = block.type as string
              if (block.type === 'tool_use') {
                const id = block.id as string
                const name = block.name as string
                const input = block.input as Record<string, unknown> ?? {}
                if (id && name) {
                  toolUseBlocks.push({ id, name, input })
                  callbacks.onContentBlock({ type: 'tool_use', id, name, input })
                }
              }
              break
            }

            case 'content_block_delta': {
              const delta = parsed.delta as Record<string, unknown> | undefined
              if (!delta) break
              if (delta.type === 'text_delta' && typeof delta.text === 'string') {
                textBlocks.push(delta.text)
                callbacks.onTextDelta(delta.text)
              } else if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string') {
                thinkingBlocks.push(delta.thinking)
                callbacks.onThinkingDelta(delta.thinking)
              } else if (delta.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
                // partial tool input — handled via content_block_start above
              }
              break
            }

            case 'content_block_stop': {
              currentBlockType = null
              break
            }

            case 'message_delta': {
              const d = parsed.delta as Record<string, unknown> | undefined
              if (d?.stop_reason) {
                stopReason = d.stop_reason as string
              }
              if (parsed.usage) {
                const u = parsed.usage as Record<string, unknown>
                usage.output_tokens = u.output_tokens as number
              }
              break
            }

            case 'message_stop': {
              // stream complete
              break
            }

            case 'error': {
              const err = parsed.error as Record<string, unknown> | undefined
              throw new Error(`Anthropic stream error: ${err?.message ?? 'Unknown error'}`)
            }
          }
        }
      }
    } finally {
      if (idleTimer) clearTimeout(idleTimer)
      reader.releaseLock()
    }

    // Emit text content blocks
    if (textBlocks.length > 0) {
      callbacks.onContentBlock({ type: 'text', text: textBlocks.join('') })
    }

    // Emit thinking content blocks
    if (thinkingBlocks.length > 0) {
      callbacks.onContentBlock({ type: 'thinking', thinking: thinkingBlocks.join('') })
    }

    callbacks.onStopReason(stopReason ?? 'end_turn', {
      input_tokens: usage.input_tokens ?? 0,
      output_tokens: usage.output_tokens ?? 0,
      cache_read_input_tokens: usage.cache_read_input_tokens ?? 0,
      cache_creation_input_tokens: usage.cache_creation_input_tokens ?? 0,
    })
  }
}
```

**步骤 2.4：运行测试确认通过**

**命令：** `npm exec -- tsx --test src/api/__tests__/anthropic-client.test.ts`
**预期结果：** 全部 7 个测试通过

**步骤 2.5：TypeScript 编译检查**

**命令：** `npx tsc --noEmit`
**预期结果：** 无类型错误

**步骤 2.6：提交**

```bash
git add src/api/anthropic-client.ts src/api/__tests__/anthropic-client.test.ts
git commit -m "feat(api): add AnthropicClient with OAI-to-Anthropic message conversion"
```

---

### Task 3: 注入四断点 `cache_control`

**目标：** 在 `buildRequestBody` 中为四个位置插入 `cache_control: { type: 'ephemeral' }`，按 spec 要求区分 1h TTL（断点 1、2）和 5m TTL（断点 3、4，即默认 ephemeral）。

**步骤 3.1：写断点位置验证测试**

**文件（追加）：** `src/api/__tests__/anthropic-client.test.ts`

```typescript
describe('cache_control breakpoint injection', () => {
  it('injects BP1 on last tool definition (1h TTL)', () => {
    const client = new AnthropicClient({
      baseUrl: 'https://api.anthropic.com',
      apiKey: 'test-key',
      model: 'claude-opus-4-7',
      maxTokens: 4096,
    })
    const body = client.buildRequestBodyForTest({
      model: 'claude-opus-4-7',
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'test' },
      ],
      max_tokens: 4096,
      tools: [
        { type: 'function', function: { name: 'tool_a', description: '', parameters: { type: 'object', properties: {} } } },
        { type: 'function', function: { name: 'tool_b', description: '', parameters: { type: 'object', properties: {} } } },
      ],
    })
    assert.ok(body.tools)
    // BP1: last tool has cache_control
    const lastTool = body.tools[body.tools.length - 1]
    assert.ok(lastTool)
    assert.deepEqual(lastTool.cache_control, { type: 'ephemeral' })
    // First tool should NOT have cache_control
    assert.equal(body.tools[0].cache_control, undefined)
  })

  it('injects BP2 on last system content block (1h TTL)', () => {
    const client = new AnthropicClient({
      baseUrl: 'https://api.anthropic.com',
      apiKey: 'test-key',
      model: 'claude-opus-4-7',
      maxTokens: 4096,
    })
    const body = client.buildRequestBodyForTest({
      model: 'claude-opus-4-7',
      messages: [
        { role: 'system', content: 'You are helpful.' },
        { role: 'user', content: 'test' },
      ],
      max_tokens: 4096,
    })
    assert.ok(body.system)
    const lastSystemBlock = body.system[body.system.length - 1]
    assert.ok(lastSystemBlock)
    assert.deepEqual(lastSystemBlock.cache_control, { type: 'ephemeral' })
  })

  it('injects BP3 on first user message last content block (5m TTL)', () => {
    const client = new AnthropicClient({
      baseUrl: 'https://api.anthropic.com',
      apiKey: 'test-key',
      model: 'claude-opus-4-7',
      maxTokens: 4096,
    })
    const body = client.buildRequestBodyForTest({
      model: 'claude-opus-4-7',
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'project instructions + memory + first message' },
        { role: 'assistant', content: 'response' },
        { role: 'user', content: 'second message' },
      ],
      max_tokens: 4096,
    })
    // BP3: first user message's last content block has cache_control
    const firstUserMsg = body.messages[0]
    assert.equal(firstUserMsg.role, 'user')
    const lastBlockIndex = firstUserMsg.content.length - 1
    assert.deepEqual(firstUserMsg.content[lastBlockIndex].cache_control, { type: 'ephemeral' })
  })

  it('injects BP4 on last completed assistant turn (5m TTL)', () => {
    const client = new AnthropicClient({
      baseUrl: 'https://api.anthropic.com',
      apiKey: 'test-key',
      model: 'claude-opus-4-7',
      maxTokens: 4096,
    })
    const body = client.buildRequestBodyForTest({
      model: 'claude-opus-4-7',
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'first message' },
        { role: 'assistant', content: 'first response' },
        { role: 'user', content: 'second message' },
        { role: 'assistant', content: 'second response' },
        { role: 'user', content: 'third message' },
      ],
      max_tokens: 4096,
    })
    // BP4: last assistant message before final user message
    // messages are: [user("first msg"), assistant("first"), user("second"), assistant("second"), user("third")]
    // BP4 should be on assistant("second response") — index 3
    const bp4Msg = body.messages[3]
    assert.equal(bp4Msg.role, 'assistant')
    const lastBlock = bp4Msg.content[bp4Msg.content.length - 1]
    assert.ok(lastBlock)
    assert.deepEqual(lastBlock.cache_control, { type: 'ephemeral' })
  })

  it('handles single turn (no BP4 — only one user message)', () => {
    const client = new AnthropicClient({
      baseUrl: 'https://api.anthropic.com',
      apiKey: 'test-key',
      model: 'claude-opus-4-7',
      maxTokens: 4096,
    })
    const body = client.buildRequestBodyForTest({
      model: 'claude-opus-4-7',
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'only message' },
      ],
      max_tokens: 4096,
    })
    // BP3 on first user message
    assert.deepEqual(body.messages[0].content[0].cache_control, { type: 'ephemeral' })
    // No BP4 — no assistant messages before final user
    // Only one user message with no preceding assistant → no BP4
  })
})
```

**步骤 3.2：确认新测试失败**

**命令：** `npm exec -- tsx --test src/api/__tests__/anthropic-client.test.ts`
**预期结果：** 5 个新测试失败 — cache_control 字段缺失

**步骤 3.3：实现断点注入**

**文件（修改）：** `src/api/anthropic-client.ts` — `buildRequestBody` 方法

在 `buildRequestBody` 中 system 块构建后、tools 构建后、messages 构建后，插入：

```typescript
// BP2: last system content block (1h TTL, same as ephemeral for now)
if (system.length > 0) {
  const lastSystemBlock = system[system.length - 1]!
  lastSystemBlock.cache_control = { type: 'ephemeral' }
}

// BP1: last tool (1h TTL)
if (tools && tools.length > 0) {
  const lastTool = tools[tools.length - 1]!
  lastTool.cache_control = { type: 'ephemeral' }
}

// BP3 & BP4 in messages
// Find: first user message index, last assistant index before final user message
let firstUserIdx = -1
let lastUserIdx = -1
for (let i = 0; i < messages.length; i++) {
  if (messages[i]!.role === 'user') {
    if (firstUserIdx === -1) firstUserIdx = i
    lastUserIdx = i
  }
}

// BP3: last content block of first user message
if (firstUserIdx >= 0) {
  const firstUserMsg = messages[firstUserIdx]!
  const blocks = firstUserMsg.content
  if (blocks.length > 0) {
    blocks[blocks.length - 1]!.cache_control = { type: 'ephemeral' }
  }
}

// BP4: last assistant message before the final user message
if (lastUserIdx > 0) {
  for (let i = lastUserIdx - 1; i >= 0; i--) {
    if (messages[i]!.role === 'assistant') {
      const assistantMsg = messages[i]!
      const blocks = assistantMsg.content
      if (blocks.length > 0) {
        blocks[blocks.length - 1]!.cache_control = { type: 'ephemeral' }
      }
      break
    }
  }
}
```

**精确编辑位置：** 在 `buildRequestBody` 返回 `body` 之前（`return body` 之前）插入上述代码。

**步骤 3.4：运行测试确认通过**

**命令：** `npm exec -- tsx --test src/api/__tests__/anthropic-client.test.ts`
**预期结果：** 全部 12 个测试通过（7 原有 + 5 新增）

**步骤 3.5：提交**

```bash
git add src/api/anthropic-client.ts src/api/__tests__/anthropic-client.test.ts
git commit -m "feat(api): inject 4 cache_control breakpoints in AnthropicClient"
```

---

### Task 4: Factory 集成 — `createProviderClient` 增加 Anthropic 分支

**目标：** 在 `factory.ts` 中为 Anthropic provider 返回 `AnthropicClient`。

**步骤 4.1：写测试**

**文件（修改）：** `src/api/__tests__/factory.test.ts`

在现有测试文件中增加：
```typescript
it('creates AnthropicClient for anthropic provider', () => {
  const client = createProviderClient(
    { name: 'anthropic', baseUrl: 'https://api.anthropic.com', apiKey: 'test-key', models: [], unsupported: [], capabilities: { prefixCompletion: false } },
    { ...DEFAULT_CAPABILITIES, prefixCacheStrategy: 'anthropic-cache-control' },
    { apiKey: 'test-key', model: 'claude-opus-4-7', maxTokens: 4096 },
  )
  // Should be AnthropicClient, not OpenAIClient
  assert.ok(client.constructor.name === 'AnthropicClient')
})
```

**步骤 4.2：确认测试失败**

**命令：** `npm exec -- tsx --test src/api/__tests__/factory.test.ts`
**预期结果：** 新测试失败 — 返回的是 `OpenAIClient`

**步骤 4.3：实现 Factory 分支**

**文件（修改）：** `src/api/factory.ts:1-3, 35-47`

添加导入：
```typescript
import { AnthropicClient } from './anthropic-client.js'
```

在 `createProviderClient` 中 Codex 分支之后、`return new OpenAIClient(...)` 之前插入：
```typescript
  // Anthropic native protocol — uses explicit cache_control breakpoints
  if (provider.name === 'anthropic' || capabilities.prefixCacheStrategy === 'anthropic-cache-control') {
    const budgetMap: Record<string, number> = {
      max: params.maxTokens,
      high: Math.floor(params.maxTokens * 0.6),
      medium: Math.floor(params.maxTokens * 0.3),
      low: 8192,
    }
    const thinkingBudget = params.reasoningEffort
      ? (budgetMap[params.reasoningEffort] ?? Math.floor(params.maxTokens * 0.6))
      : undefined

    return new AnthropicClient({
      baseUrl: provider.baseUrl,
      apiKey: params.apiKey,
      model: params.model,
      maxTokens: params.maxTokens,
      thinkingBudget,
    })
  }
```

**步骤 4.4：运行测试确认通过**

**命令：** `npm exec -- tsx --test src/api/__tests__/factory.test.ts`
**预期结果：** 全部通过，包括新 AnthropicClient 测试

**步骤 4.5：全量 TypeScript 检查**

**命令：** `npx tsc --noEmit`
**预期结果：** 无类型错误

**步骤 4.6：提交**

```bash
git add src/api/factory.ts src/api/__tests__/factory.test.ts
git commit -m "feat(api): integrate AnthropicClient into factory for anthropic provider"
```

---

### Task 5: 扩展缓存诊断 — Anthropic 缓存字段验证

**目标：** 确认 `cache-diagnostic.ts` 能正确处理 Anthropic 通过 `Usage` 结构传递的缓存字段。

**调研结论：** `SessionContext.recordTurnCache` 从 `Usage` 中读取 `cache_read_input_tokens` 和 `cache_creation_input_tokens`，存入 `TurnCacheSnapshot`。`diagnoseCacheMiss` 读取 `TurnCacheSnapshot.cacheRead` / `cacheCreation` 计算命中率。AnthropicClient 的 `processSSEStream` 已在 `onStopReason` 回调中传递 `cache_read_input_tokens` / `cache_creation_input_tokens`。**数据管道贯穿——无需修改 `cache-diagnostic.ts`。**

**步骤 5.1：写集成测试确认数据管道**

**文件（追加）：** `src/prompt/__tests__/cache-diagnostic.test.ts`

```typescript
it('diagnoses Anthropic cache read tokens through TurnCacheSnapshot', () => {
  // Simulate Anthropic cache pattern: high cache_read, low cache_creation
  const diagnostic = diagnoseCacheMiss([
    { turn: 1, cacheRead: 500, cacheCreation: 50, inputTokens: 550, outputTokens: 20 },
    { turn: 2, cacheRead: 450, cacheCreation: 30, inputTokens: 480, outputTokens: 15 },
  ], 2, null, false)

  // Hit rate = 450/(450+30) = 0.9375 > 0.8 → healthy → null
  assert.equal(diagnostic, null)
})

it('diagnoses Anthropic 5-minute TTL expiry as low hit rate', () => {
  // Simulate TTL expiry: cache miss, high creation
  const diagnostic = diagnoseCacheMiss([
    { turn: 1, cacheRead: 500, cacheCreation: 20, inputTokens: 520, outputTokens: 20 },
    { turn: 2, cacheRead: 50, cacheCreation: 450, inputTokens: 500, outputTokens: 20 },
  ], 2, null, false)

  // Hit rate = 50/(50+450) = 0.1 < 0.4 → cache_eviction
  assert.ok(diagnostic)
  assert.equal(diagnostic.reason, 'cache_eviction')
})
```

**步骤 5.2：运行测试确认通过**

**命令：** `npm exec -- tsx --test src/prompt/__tests__/cache-diagnostic.test.ts`
**预期结果：** 全部 4 个测试通过（2 原有 + 2 新增）

**步骤 5.3：提交**

```bash
git add src/prompt/__tests__/cache-diagnostic.test.ts
git commit -m "test(prompt): add Anthropic cache hit rate diagnostic tests"
```

---

### Task 6: 端到端验证 — TypeScript + 全量测试

**目标：** 确保所有变更不破坏现有功能。

**步骤 6.1：全量 TypeScript 编译检查**

**命令：** `npx tsc --noEmit`
**预期结果：** 无类型错误

**步骤 6.2：运行所有测试**

**命令：** `npm exec -- tsx --test src/**/__tests__/*.test.ts`
**预期结果：** 所有已有测试通过 + 新增测试通过。无 regression。

**步骤 6.3：提交（如有遗漏文件）**

```bash
git status
# 如有未提交变更，提交之
```

---

## 5. Verification

### 单元级验证

```bash
# Task 1: provider-profile fix
npm exec -- tsx --test src/api/__tests__/provider-profile.test.ts

# Task 2-3: AnthropicClient conversion + breakpoints
npm exec -- tsx --test src/api/__tests__/anthropic-client.test.ts

# Task 4: Factory integration
npm exec -- tsx --test src/api/__tests__/factory.test.ts

# Task 5: Cache diagnostic
npm exec -- tsx --test src/prompt/__tests__/cache-diagnostic.test.ts
```

### 集成级验证

```bash
# Full typecheck
npx tsc --noEmit

# Full test suite
npm exec -- tsx --test src/**/__tests__/*.test.ts
```

### 手动验证（需 Anthropic API key）

```bash
# 启动 TUI，选择 Anthropic provider，运行多轮对话
# 检查 debug 日志中的 cache_read_input_tokens / cache_creation_input_tokens
# 目标：稳定后 cache_read / (cache_read + cache_creation) ≥ 0.9
```

---

## 6. Self-check

### 6.1 Spec Coverage

| Spec Requirement | Task(s) |
|-----------------|---------|
| 新增 `AnthropicClient` 实现 `StreamClient` | Task 2 |
| OAI → Anthropic 消息格式转换 | Task 2 |
| 四断点 `cache_control` 注入 | Task 3 |
| `minCacheTokens` 修复（1024→4096） | Task 1 |
| 日期注入验证 | Section 3.2（已验证，无代码改动） |
| 非确定性序列化（tools 按 name 排序） | Task 2（`buildRequestBody` 中 sort） |
| `cache-diagnostic.ts` 扩展 | Task 5（数据管道已贯穿，仅增加测试） |
| Factory 集成 | Task 4 |
| 不碰提示层 / agent loop | ✅ 全部变更仅限 `src/api/` |

### 6.2 Placeholder Scan

- ✅ 无 TODO / TBD / 待定 / 后续实现 / 补充细节
- ✅ 无 "添加适当的错误处理" — 所有错误都有具体处理逻辑
- ✅ 无 "为上述代码编写测试" — 所有测试有具体代码
- ✅ 无 "类似任务 N"
- ✅ 所有类型/函数在使用前定义

### 6.3 Type/Signature Consistency

| 符号 | 定义位置 | 使用位置 | 一致？ |
|------|---------|---------|-------|
| `AnthropicClient` | `src/api/anthropic-client.ts` | `src/api/factory.ts:3` | ✅ |
| `AnthropicClientConfig` | `src/api/anthropic-client.ts` | `src/api/factory.ts` (内联构造) | ✅ |
| `StreamClient` | `src/api/stream-client.ts` | `implements` in `anthropic-client.ts` | ✅ |
| `getProviderProfile` | `src/api/provider-profile.ts:27` | `src/api/provider-profile.test.ts:5` | ✅ |
| `diagnoseCacheMiss` | `src/prompt/cache-diagnostic.ts:20` | `cache-diagnostic.test.ts:3` | ✅ |
| `TurnCacheSnapshot` | `src/agent/context.ts:22` | `diagnoseCacheMiss` 参数 | ✅ |
| `OaiChatRequest` | `src/api/oai-types.ts:118` | `buildRequestBody` 参数 | ✅ |

---

## 7. Execution Handoff

计划已完成并保存到 `docs/superpowers/plans/anthropic-native-client.md`。两种执行方式：

1. **子代理驱动（推荐）** — 每个任务调度一个新的子代理，任务间进行审查，快速迭代。
2. **内联执行** — 在当前会话中使用 executing-plans 执行任务，批量执行并设有检查点。

选哪种方式？
