# OpenAI 原生格式迁移实施计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 将 Rivet 内部 message 格式从 Anthropic-style content blocks（`tool_use`/`tool_result` 嵌套在 `content: ContentBlock[]` 中）迁移到 OpenAI 原生格式（`role: 'tool'` + `tool_calls` 字段），消除 openai-client.ts 中的格式转换层。

**架构：** 当前 Rivet 内部使用 Anthropic 格式，在 openai-client.ts 中转换为 OpenAI 格式再发 API。迁移后，内部格式直接是 OpenAI 格式——与 DeepSeek/MiMo/GLM 等所有目标模型的 API 原生一致。转换层从"每次 API 调用都转"变为"不需要转"。

**技术栈：** TypeScript strict / Node.js 22+ / DeepSeek V4 API / OpenAI Chat Completions 格式

**风险等级：** HIGH — 改动面 ~35 个源文件 + ~30 个测试文件，需要分支隔离 + 全量回归

---

## 动机

1. **所有目标模型都用 OpenAI 格式**：DeepSeek、MiMo、GLM、Codex 全部是 OpenAI-compatible API。Anthropic 格式是历史遗留。
2. **转换层是 bug 源**：openai-client.ts 的 80 行转换代码处理 thinking blocks、tool pairing、content 拼接——每次加新功能都要同步维护两套格式。
3. **验证脚本无法直接用 engine.buildRequest**：当前验证脚本必须绕过 engine 直接构建 OpenAI 格式，无法测试真实业务路径。
4. **prefix cache 验证需要字节级一致**：格式转换引入的不确定性（如 JSON key 顺序）可能影响 cache hit。

---

## 格式对比

### 当前（Anthropic-style）

```typescript
// Assistant with tool call
{ role: 'assistant', content: [
  { type: 'text', text: 'Let me read that file.' },
  { type: 'tool_use', id: 'tu-1', name: 'read_file', input: { file_path: '/src/app.ts' } }
]}

// Tool result (嵌套在 user message 的 content blocks 中)
{ role: 'user', content: [
  { type: 'tool_result', tool_use_id: 'tu-1', content: '...file content...' }
]}
```

### 目标（OpenAI-native）

```typescript
// Assistant with tool call
{ role: 'assistant', content: 'Let me read that file.', tool_calls: [
  { id: 'tu-1', type: 'function', function: { name: 'read_file', arguments: '{"file_path":"/src/app.ts"}' } }
]}

// Tool result (独立的 role=tool message)
{ role: 'tool', tool_call_id: 'tu-1', content: '...file content...' }
```

### 关键差异

| 维度 | Anthropic | OpenAI |
|------|-----------|--------|
| Tool call 位置 | `content: ContentBlock[]` 中的 `tool_use` block | 独立的 `tool_calls` 字段 |
| Tool result 位置 | `role: 'user'` message 的 `content: ContentBlock[]` | 独立的 `role: 'tool'` message |
| Text + tool 混合 | 同一个 content array 中 | text 在 `content` 字段，tools 在 `tool_calls` 字段 |
| Thinking | `{ type: 'thinking', thinking: '...' }` block | `reasoning_content` 字段（DeepSeek 扩展） |
| Message role | 只有 `user` / `assistant` | `user` / `assistant` / `tool` / `system` |

---

## 迁移策略：双格式过渡期

**不做 big-bang 切换。** 采用"新格式写入 + 旧格式兼容读取"的渐进策略：

1. **Phase 1**：定义新类型，新增 `OaiMessage` 类型系统（不删旧类型）
2. **Phase 2**：SessionContext 改为存储 `OaiMessage[]`，但提供 `toLegacy()` 兼容方法
3. **Phase 3**：PromptEngine 改为直接输出 OpenAI 格式的 `MessageRequest`
4. **Phase 4**：openai-client 删除转换层，直接透传
5. **Phase 5**：删除旧类型和兼容方法，清理测试

每个 Phase 结束后全量测试必须通过。如果某个 Phase 失败，可以回退到上一个 Phase 的状态。

---

## 文件结构

### Phase 1：新类型定义

| 文件 | 改动 |
|------|------|
| 创建：`src/api/oai-types.ts` | OpenAI 原生 Message/ToolCall/ToolResult 类型 |
| 修改：`src/api/types.ts` | 保留旧类型（标记 `@deprecated`），新增 re-export |

### Phase 2：SessionContext 迁移

| 文件 | 改动 |
|------|------|
| 修改：`src/agent/context.ts` | 内部存储改为 `OaiMessage[]`，`addToolResults` → `addToolMessages` |
| 修改：`src/agent/session-persist.ts` | JSONL 序列化/反序列化适配新格式 + 旧格式 fallback |
| 修改：`src/agent/turn-stream.ts` | API 响应解析后直接存 OaiMessage |

### Phase 3：PromptEngine 迁移

| 文件 | 改动 |
|------|------|
| 修改：`src/prompt/engine.ts` | `buildRequest` 输出 OpenAI 格式；volatile block 注入逻辑适配 |
| 修改：`src/compact/stale-round.ts` | `role === 'tool'` 替代 `block.type === 'tool_result'` |
| 修改：`src/compact/micro.ts` | 同上 |
| 修改：`src/context/rounds.ts` | round 分组从 content blocks 改为 message role |
| 修改：`src/context/resume-preflight.ts` | orphan tool_call 检测适配 |
| 修改：`src/context/microcompact.ts` | tool_result 截断适配 |

### Phase 4：Client 层清理

| 文件 | 改动 |
|------|------|
| 修改：`src/api/openai-client.ts` | 删除 `buildRequestBody` 中的 Anthropic→OpenAI 转换（~80 行） |
| 修改：`src/api/codex-client.ts` | 适配新格式 |
| 修改：`src/api/client.ts` | 响应解析直接输出 OaiMessage |

### Phase 5：清理

| 文件 | 改动 |
|------|------|
| 修改：`src/api/types.ts` | 删除 `ContentBlockToolUse`、`ContentBlockToolResult`、旧 `Message` |
| 修改：`src/agent/tool-execution.ts` | 删除 legacy content block 构建 |
| 修改：`src/agent/tool-pipeline.ts` | 适配 |
| 修改：`src/tui/history-replay.ts` | 渲染适配 |
| 修改：`src/headless.ts` | 输出适配 |
| 修改：`src/agent/ctcl-sanitizer.ts` | 字段映射更新 |
| 删除所有 `@deprecated` 标记和兼容方法 | |

---

## 任务 1：定义 OpenAI 原生类型系统（Phase 1）

**文件：**
- 创建：`src/api/oai-types.ts`

- [x] **步骤 1：创建 OaiMessage 类型定义**

```typescript
// src/api/oai-types.ts

/** OpenAI function call in assistant message */
export interface OaiToolCall {
  id: string
  type: 'function'
  function: {
    name: string
    arguments: string  // JSON string
  }
}

/** System message */
export interface OaiSystemMessage {
  role: 'system'
  content: string
}

/** User message */
export interface OaiUserMessage {
  role: 'user'
  content: string
}

/** Assistant message (may include tool_calls) */
export interface OaiAssistantMessage {
  role: 'assistant'
  content: string | null
  tool_calls?: OaiToolCall[]
  reasoning_content?: string  // DeepSeek thinking
}

/** Tool result message */
export interface OaiToolMessage {
  role: 'tool'
  tool_call_id: string
  content: string
}

export type OaiMessage =
  | OaiSystemMessage
  | OaiUserMessage
  | OaiAssistantMessage
  | OaiToolMessage

/** Type guards */
export function isToolMessage(msg: OaiMessage): msg is OaiToolMessage {
  return msg.role === 'tool'
}

export function isAssistantWithTools(msg: OaiMessage): msg is OaiAssistantMessage & { tool_calls: OaiToolCall[] } {
  return msg.role === 'assistant' && Array.isArray((msg as OaiAssistantMessage).tool_calls) && (msg as OaiAssistantMessage).tool_calls!.length > 0
}

export function isUserMessage(msg: OaiMessage): msg is OaiUserMessage {
  return msg.role === 'user'
}

/** Tool definition (OpenAI function calling format) */
export interface OaiToolDefinition {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
}

/** Request body for OpenAI-compatible APIs */
export interface OaiChatRequest {
  model: string
  messages: OaiMessage[]
  tools?: OaiToolDefinition[]
  tool_choice?: 'auto' | 'none' | { type: 'function'; function: { name: string } }
  max_tokens?: number
  stream?: boolean
  temperature?: number
  reasoning_effort?: 'low' | 'medium' | 'high' | 'max'  // DeepSeek extension
}

/** Usage stats from API response */
export interface OaiUsage {
  prompt_tokens: number
  completion_tokens: number
  prompt_cache_hit_tokens?: number
  prompt_cache_miss_tokens?: number
}
```

- [x] **步骤 2：验证类型编译**

运行：`npx tsc --noEmit src/api/oai-types.ts`
预期：无错误

- [x] **步骤 3：在 types.ts 中标记旧类型为 deprecated**

```typescript
// src/api/types.ts 顶部添加注释
/**
 * @deprecated 迁移中 — 新代码请使用 src/api/oai-types.ts 中的 OaiMessage 类型。
 * 旧的 ContentBlock-based Message 格式将在 Phase 5 删除。
 */
```

- [ ] **步骤 4：Commit**

```bash
git add src/api/oai-types.ts src/api/types.ts
git commit -m "feat(api): define OpenAI-native OaiMessage type system for format migration"
```

---

## 任务 2：SessionContext 双格式支持（Phase 2）

**文件：**
- 修改：`src/agent/context.ts`
- 测试：现有 context 相关测试

> 关键设计：SessionContext 内部改为存储 `OaiMessage[]`，但保留 `getMessages(): Message[]` 方法（转换为旧格式）供未迁移的消费者使用。新增 `getOaiMessages(): OaiMessage[]` 供已迁移的消费者使用。

- [x] **步骤 1：添加 OaiMessage 存储和转换方法**

```typescript
// src/agent/context.ts — 新增 import
import type { OaiMessage, OaiAssistantMessage, OaiToolMessage, OaiToolCall } from '../api/oai-types.js'

// 新增方法：
/** Add assistant message with optional tool calls (OpenAI format) */
addAssistantOai(content: string | null, toolCalls?: OaiToolCall[], reasoning?: string): void {
  const msg: OaiAssistantMessage = { role: 'assistant', content, ...(toolCalls && { tool_calls: toolCalls }), ...(reasoning && { reasoning_content: reasoning }) }
  this.state.oaiMessages.push(msg)
  // 同步到旧格式（过渡期）
  this.syncLegacyFromOai(msg)
}

/** Add tool result messages (OpenAI format) */
addToolResultsOai(results: Array<{ toolCallId: string; content: string }>): void {
  for (const r of results) {
    const msg: OaiToolMessage = { role: 'tool', tool_call_id: r.toolCallId, content: r.content }
    this.state.oaiMessages.push(msg)
  }
  // 同步到旧格式（过渡期）
  this.syncLegacyToolResults(results)
}

/** Get messages in OpenAI format (new consumers) */
getOaiMessages(): OaiMessage[] {
  return this.state.oaiMessages
}
```

- [x] **步骤 2：添加旧格式 → OaiMessage 的加载兼容（SessionContext load/replace 层）**

```typescript
// session-persist.ts 加载旧 JSONL 时，检测格式并转换
function migrateMessageToOai(msg: any): OaiMessage {
  // 旧格式：role='user', content=[{type:'tool_result',...}]
  if (msg.role === 'user' && Array.isArray(msg.content)) {
    const toolResults = msg.content.filter((b: any) => b.type === 'tool_result')
    if (toolResults.length > 0) {
      // 返回多条 OaiToolMessage
      return toolResults.map((b: any) => ({ role: 'tool', tool_call_id: b.tool_use_id, content: b.content }))
    }
  }
  // 旧格式：role='assistant', content=[{type:'tool_use',...}]
  if (msg.role === 'assistant' && Array.isArray(msg.content)) {
    const text = msg.content.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('')
    const toolCalls = msg.content.filter((b: any) => b.type === 'tool_use').map((b: any) => ({
      id: b.id, type: 'function', function: { name: b.name, arguments: JSON.stringify(b.input) }
    }))
    return { role: 'assistant', content: text || null, ...(toolCalls.length > 0 && { tool_calls: toolCalls }) }
  }
  // 已经是 OAI 格式或纯文本
  return msg
}
```

- [x] **步骤 3：运行现有测试确认不破坏（Task 2A targeted）**

运行：`npx tsx --test src/agent/__tests__/context.test.ts`（如果存在）
运行：`npm test`
预期：2694/2695 通过（RSS 测试除外）

**Task 2A 当前状态（2026-05-22）**：已将 `SessionContext` 改为 OAI 单一权威存储，`getMessages()` 为 on-demand legacy view，新增 `getOaiMessages()`。为避免破坏现有调用方，OAI message 内部用非枚举对外不可见的 symbol 元数据记录 legacy view 的 string/block 形状；这不是双份 message 状态，只用于过渡期 `getMessages()` 兼容。已验证：`context.test.ts`、`context-ledger-state.test.ts`、`context-injection.test.ts`、`worker-session.test.ts`、`turn-completion.test.ts`、`loop.test.ts`、`session-persist.test.ts`、`turn-stream.test.ts`、`compaction-controller.test.ts`，以及 `npx tsc --noEmit`。

**Task 2B 当前状态（2026-05-22）**：`session-persist.ts` 新增 `appendOaiWithChecksum()`、`loadOai()` 与 `serializeOaiSessionMessage()`；`loadOai()` 可直接读取 OAI rows，也可把 legacy rows 迁移为 OAI messages。保留既有 `load()` / `loadRecoverableMessages()` legacy 返回值，避免扩大 Phase 2 改动面。已新增 `session-persist.test.ts` 覆盖 OAI checksum append/load 与 legacy→OAI load 迁移。全量验证通过：`npx tsc --noEmit && ./node_modules/.bin/tsx --test src/**/__tests__/*.test.ts`（2487 pass）。

- [ ] **步骤 4：Commit**

```bash
git add src/agent/context.ts src/agent/session-persist.ts
git commit -m "feat(agent): add OaiMessage dual-format support to SessionContext"
```

---

## 任务 3：PromptEngine 输出 OpenAI 格式（Phase 3）

**文件：**
- 修改：`src/prompt/engine.ts`

> 这是最复杂的任务。buildRequest 当前遍历 `Message[]`（Anthropic 格式），注入 volatile blocks，输出 `MessageRequest`。迁移后，它遍历 `OaiMessage[]`，注入 volatile blocks 为 `role: 'user'` messages，输出 `OaiChatRequest`。

- [x] **步骤 1：新增 buildOaiRequest 方法（不删旧方法）**

```typescript
// src/prompt/engine.ts
import type { OaiMessage, OaiChatRequest, OaiToolDefinition } from '../api/oai-types.js'

/** Build request in OpenAI-native format. New primary method. */
buildOaiRequest(oaiMessages: OaiMessage[], toolHistory?: ToolHistoryEntry[]): OaiChatRequest {
  const result: OaiMessage[] = []

  // Find last user message index for FRESH volatile injection
  let lastUserIdx = -1
  for (let i = oaiMessages.length - 1; i >= 0; i--) {
    if (oaiMessages[i]!.role === 'user') { lastUserIdx = i; break }
  }

  for (let i = 0; i < oaiMessages.length; i++) {
    const msg = oaiMessages[i]!
    if (msg.role === 'user') {
      if (i === lastUserIdx) {
        // Inject FRESH volatile before last user message
        result.push({ role: 'user', content: this.cachedFreshBlock })
      } else if (i === 0) {
        // Inject FROZEN volatile before first user message (prefix cache anchor)
        result.push({ role: 'user', content: this.volatileBlock })
      }
    }
    result.push(msg)
  }

  return {
    model: this.config.model,
    messages: result,
    max_tokens: this.config.maxTokens,
    tools: this.config.staticCtx.tools.length > 0
      ? this.config.staticCtx.tools.map(t => ({ type: 'function' as const, function: { name: t.name, description: t.description, parameters: t.input_schema } }))
      : undefined,
    tool_choice: this.config.staticCtx.tools.length > 0 ? 'auto' : undefined,
    stream: true,
  }
}
```

- [x] **步骤 2：保留旧 buildRequest 作为兼容层**

```typescript
/** @deprecated Use buildOaiRequest. This method converts internally. */
buildRequest(messages: Message[], toolHistory?: ToolHistoryEntry[]): MessageRequest {
  // 旧实现保持不变，过渡期使用
  // ...existing code...
}
```

- [x] **步骤 3：运行测试（Task 3A targeted）**

运行：`npm test`
预期：全部通过（新方法是新增的，不影响旧路径）

**Task 3A 当前状态（2026-05-22）**：已新增 `PromptEngine.buildOaiRequest()`，旧 `buildRequest()` 保留且 AgentLoop 尚未切换。新方法直接输出 `OaiChatRequest`，对 OAI `role: 'user'` 注入独立 volatile user message；最后一个 user message 使用 cached FRESH，历史 user message 使用 FROZEN，`role: 'tool'` 不触发 volatile 注入。已新增 `src/prompt/__tests__/engine.test.ts` 覆盖 OAI request shape、同一 user/tool-turn 复用 cached fresh、新 user boundary 刷新 fresh。已验证：`engine.test.ts`、`engine-cache-stability.test.ts`、`chat-mode-engine.test.ts`、`fingerprint.test.ts`，以及 `npx tsc --noEmit`。

**Task 3B 当前状态（2026-05-22）**：已补 Patch I 的最小双路径 canonical parity 框架。`buildOaiRequest()` 现输出与旧 `buildRequest()`→OpenAI body 对齐的 `system` message 与 `stream_options: { include_usage: true }`；测试内通过 `canonicalLegacyRequestBody()` 与 `canonicalOaiBody()` 比较 `stableStringify` 字节。已覆盖 tool-call-only assistant 与 assistant text + tool_calls 两条等价 transcript。已验证：`./node_modules/.bin/tsx --test src/prompt/__tests__/engine.test.ts && npx tsc --noEmit`。完整 provider-specific request-body parity 仍留给 Phase 4 client 切换前。

- [ ] **步骤 4：Commit**

```bash
git add src/prompt/engine.ts
git commit -m "feat(prompt): add buildOaiRequest for OpenAI-native output (dual-path)"
```

---

## 任务 4：Compaction 管线适配（Phase 3 续）

**文件：**
- 修改：`src/compact/stale-round.ts`
- 修改：`src/compact/micro.ts`
- 修改：`src/context/rounds.ts`
- 修改：`src/context/resume-preflight.ts`

> 这些模块当前通过 `block.type === 'tool_result'` 识别 tool 输出。迁移后改为 `msg.role === 'tool'`。

- [ ] **步骤 1：stale-round.ts 适配**

```typescript
// src/compact/stale-round.ts — 新增 OAI 格式处理
import type { OaiMessage } from '../api/oai-types.js'

export function compactStaleRoundsOai(messages: OaiMessage[], _contextWindow: number): OaiMessage[] {
  if (messages.length <= CACHE_ANCHOR_MESSAGES + RECENT_MESSAGES_TO_KEEP) return messages

  const recentStart = Math.max(CACHE_ANCHOR_MESSAGES, messages.length - RECENT_MESSAGES_TO_KEEP)
  let changed = false

  const result = messages.map((msg, idx) => {
    if (idx < CACHE_ANCHOR_MESSAGES || idx >= recentStart) return msg
    if (msg.role !== 'tool') return msg
    if (msg.content.length <= STALE_PREVIEW_CHARS) return msg

    changed = true
    const preview = msg.content.slice(0, STALE_PREVIEW_CHARS)
    return { ...msg, content: `${preview}\n<stale-compacted removed_chars="${msg.content.length - STALE_PREVIEW_CHARS}" />` }
  })

  return changed ? result : messages
}
```

- [ ] **步骤 2：rounds.ts 适配**

```typescript
// src/context/rounds.ts — 新增 OAI round 分组
import type { OaiMessage } from '../api/oai-types.js'

export interface OaiRound {
  userMsg: OaiMessage        // role='user'
  assistantMsg: OaiMessage   // role='assistant' (may have tool_calls)
  toolMsgs: OaiMessage[]     // role='tool' responses
  startIdx: number
  endIdx: number
}

export function groupIntoOaiRounds(messages: OaiMessage[]): OaiRound[] {
  const rounds: OaiRound[] = []
  let i = 0
  while (i < messages.length) {
    if (messages[i]!.role === 'user') {
      const userMsg = messages[i]!
      const startIdx = i
      i++
      if (i < messages.length && messages[i]!.role === 'assistant') {
        const assistantMsg = messages[i]!
        i++
        const toolMsgs: OaiMessage[] = []
        while (i < messages.length && messages[i]!.role === 'tool') {
          toolMsgs.push(messages[i]!)
          i++
        }
        rounds.push({ userMsg, assistantMsg, toolMsgs, startIdx, endIdx: i - 1 })
      } else {
        rounds.push({ userMsg, assistantMsg: { role: 'assistant', content: '' }, toolMsgs: [], startIdx, endIdx: startIdx })
      }
    } else {
      i++
    }
  }
  return rounds
}
```

- [ ] **步骤 3：resume-preflight.ts 适配**

```typescript
// 检测 orphan tool_calls（assistant 有 tool_calls 但没有对应的 role=tool 响应）
export function detectOrphanToolCallsOai(messages: OaiMessage[]): string[] {
  const orphanIds: string[] = []
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]!
    if (msg.role === 'assistant' && 'tool_calls' in msg && msg.tool_calls) {
      for (const tc of msg.tool_calls) {
        const hasResult = messages.slice(i + 1).some(m => m.role === 'tool' && 'tool_call_id' in m && m.tool_call_id === tc.id)
        if (!hasResult) orphanIds.push(tc.id)
      }
    }
  }
  return orphanIds
}
```

- [ ] **步骤 4：运行测试**

运行：`npm test`
预期：全部通过

- [ ] **步骤 5：Commit**

```bash
git add src/compact/stale-round.ts src/compact/micro.ts src/context/rounds.ts src/context/resume-preflight.ts
git commit -m "feat(compact): add OAI-format compaction and round grouping"
```

---

## 任务 5：openai-client 删除转换层（Phase 4）

**文件：**
- 修改：`src/api/openai-client.ts`

> 当 AgentLoop 切换到使用 `buildOaiRequest` + `getOaiMessages` 后，openai-client 不再需要 Anthropic→OpenAI 转换。

- [ ] **步骤 1：新增 streamOai 方法（直接透传）**

```typescript
// src/api/openai-client.ts
import type { OaiChatRequest } from './oai-types.js'

/** Stream with pre-built OpenAI request — no format conversion needed. */
async streamOai(request: OaiChatRequest, callbacks: StreamCallbacks, signal?: AbortSignal): Promise<void> {
  const body: Record<string, unknown> = {
    model: request.model,
    messages: request.messages,
    stream: true,
    max_tokens: request.max_tokens,
  }
  if (request.tools) body.tools = request.tools
  if (request.tool_choice) body.tool_choice = request.tool_choice
  if (request.reasoning_effort) body.reasoning_effort = request.reasoning_effort

  // 直接发送，无转换
  await this.streamRequest(body, callbacks, signal)
}
```

- [ ] **步骤 2：保留旧 stream 方法（过渡期）**

旧的 `stream(request: MessageRequest, ...)` 保留不动，标记 `@deprecated`。

- [ ] **步骤 3：Commit**

```bash
git add src/api/openai-client.ts
git commit -m "feat(api): add streamOai for direct OpenAI-format passthrough"
```

---

## 任务 6：AgentLoop 切换到 OAI 路径（Phase 4 续）

**文件：**
- 修改：`src/agent/loop.ts`
- 修改：`src/agent/turn-stream.ts`
- 修改：`src/agent/tool-execution.ts`

> 这是切换点。AgentLoop 从使用 `buildRequest` + `stream` 切换到 `buildOaiRequest` + `streamOai`。

- [ ] **步骤 1：turn-stream.ts 解析响应后存 OaiMessage**

```typescript
// 当前：解析 SSE delta → 构建 ContentBlock[] → addAssistantBlocks
// 改为：解析 SSE delta → 构建 OaiAssistantMessage → addAssistantOai
```

- [ ] **步骤 2：tool-execution.ts 构建 OaiToolMessage**

```typescript
// 当前：构建 ContentBlockToolResult[] → addToolResults
// 改为：构建 { toolCallId, content }[] → addToolResultsOai
```

- [ ] **步骤 3：loop.ts 使用 buildOaiRequest**

```typescript
// 当前 line 927:
const request = this.config.promptEngine.buildRequest(this.session.getMessages(), this.recentToolHistory)
// 改为：
const request = this.config.promptEngine.buildOaiRequest(this.session.getOaiMessages(), this.recentToolHistory)
```

- [ ] **步骤 4：全量测试**

运行：`npm test`
预期：全部通过

- [ ] **步骤 5：Commit**

```bash
git add src/agent/loop.ts src/agent/turn-stream.ts src/agent/tool-execution.ts
git commit -m "feat(agent): switch AgentLoop to OAI-native message path"
```

---

## 任务 7：TUI 和 Headless 适配（Phase 5）

**文件：**
- 修改：`src/tui/history-replay.ts`
- 修改：`src/headless.ts`

- [ ] **步骤 1：history-replay.ts 适配 OaiMessage**

```typescript
// 当前：遍历 ContentBlock[] 找 tool_use/tool_result
// 改为：遍历 OaiMessage[] 找 role='assistant'+tool_calls / role='tool'
```

- [ ] **步骤 2：headless.ts 输出适配**

```typescript
// 当前：输出 { type: 'tool_use', id, name, input }
// 改为：输出 { type: 'tool_call', id, function: { name, arguments } }
// （或保持旧格式作为 headless 的公开 API，内部转换）
```

- [ ] **步骤 3：Commit**

```bash
git add src/tui/history-replay.ts src/headless.ts
git commit -m "feat(tui): adapt history replay and headless output to OAI format"
```

---

## 任务 8：删除旧类型和兼容层（Phase 5 续）

**文件：**
- 修改：`src/api/types.ts` — 删除 `ContentBlockToolUse`、`ContentBlockToolResult`
- 修改：`src/api/openai-client.ts` — 删除旧 `buildRequestBody` 转换逻辑
- 修改：`src/agent/context.ts` — 删除 `addAssistantBlocks`、`addToolResults`、`getMessages`
- 修改：`src/prompt/engine.ts` — 删除旧 `buildRequest`
- 修改：`src/agent/ctcl-sanitizer.ts` — 更新字段映射

- [ ] **步骤 1：删除旧类型**

```typescript
// src/api/types.ts — 删除：
// ContentBlockToolUse, ContentBlockToolResult
// 保留：ContentBlockText, ContentBlockThinking（这些在 OAI 格式中仍有用）
```

- [ ] **步骤 2：删除 openai-client 转换代码**

删除 `buildRequestBody` 中 line 229-310 的 Anthropic→OpenAI 转换循环。

- [ ] **步骤 3：删除 SessionContext 兼容方法**

删除 `addAssistantBlocks`、`addToolResults`、`getMessages`（旧格式）。
重命名 `getOaiMessages` → `getMessages`。

- [ ] **步骤 4：全量测试 + 更新所有测试文件**

运行：`npm test`
预期：需要更新 ~30 个测试文件中的 mock 数据格式

- [ ] **步骤 5：Commit**

```bash
git add -A
git commit -m "refactor(api): remove legacy Anthropic content-block format — OAI-native only"
```

---

## 任务 9：测试全量更新

**文件：** 所有 `src/**/__tests__/*.test.ts`

> 这是工作量最大的任务。所有测试中构建 mock messages 的地方都需要从 Anthropic 格式改为 OpenAI 格式。

- [ ] **步骤 1：批量替换 tool_use content blocks**

```typescript
// 旧：
{ role: 'assistant', content: [{ type: 'tool_use', id: 'tu-1', name: 'read_file', input: { file_path: '/x' } }] }
// 新：
{ role: 'assistant', content: null, tool_calls: [{ id: 'tu-1', type: 'function', function: { name: 'read_file', arguments: '{"file_path":"/x"}' } }] }
```

- [ ] **步骤 2：批量替换 tool_result content blocks**

```typescript
// 旧：
{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu-1', content: 'file content' }] }
// 新：
{ role: 'tool', tool_call_id: 'tu-1', content: 'file content' }
```

- [ ] **步骤 3：运行全量测试**

运行：`npm test`
预期：2694/2695 通过

- [ ] **步骤 4：Commit**

```bash
git add src/**/__tests__/
git commit -m "test: migrate all test mocks from Anthropic to OpenAI message format"
```

---

## 回滚策略

| 阶段 | 回滚方式 |
|------|----------|
| Phase 1-2 | 删除 `oai-types.ts`，revert context.ts 改动 |
| Phase 3 | 删除 `buildOaiRequest`，旧 `buildRequest` 仍在 |
| Phase 4 | revert loop.ts 的 `buildOaiRequest` 调用，回到旧路径 |
| Phase 5 | **不可回滚** — 旧类型已删除。必须在 Phase 4 验证通过后才进入 Phase 5 |

**关键检查点**：Phase 4 完成后、Phase 5 开始前，必须：
1. 全量测试通过
2. 跑 verify-task-a/b/c 验证脚本确认 cache hit 率
3. 手动跑一个真实任务确认功能正常

---

## 旧 Session 兼容

`.rivet/sessions/` 中的 JSONL 文件使用旧格式。迁移后需要兼容读取：

```typescript
// session-persist.ts loadMessages 中
function loadAndMigrate(jsonlPath: string): OaiMessage[] {
  const lines = readFileSync(jsonlPath, 'utf-8').split('\n')
  return lines
    .filter(l => l.trim())
    .map(l => JSON.parse(l))
    .flatMap(msg => {
      // 检测旧格式并转换
      if (msg.role === 'user' && Array.isArray(msg.content)) {
        return migrateUserContentBlocks(msg)
      }
      if (msg.role === 'assistant' && Array.isArray(msg.content)) {
        return [migrateAssistantContentBlocks(msg)]
      }
      return [msg]  // 已经是 OAI 格式
    })
}
```

---

## 验收标准

| 指标 | 验证方式 |
|------|----------|
| 全量测试通过 | `npm test` — 2694+ pass |
| TypeScript 编译通过 | `npx tsc --noEmit` — 0 errors |
| Cache hit 率不降 | verify-task-a/b/c 脚本 — Recent 3 ≥80% |
| 旧 session 可加载 | 手动测试：用旧 JSONL 启动 session |
| openai-client 转换代码已删除 | `grep -c "tool_use\|tool_result" src/api/openai-client.ts` — 0 |
| 无 Anthropic 格式残留 | `grep -rn "tool_use_id\|ContentBlockToolUse\|ContentBlockToolResult" src/ | grep -v test` — 0 |

---

## 执行顺序与依赖

```
任务 1（类型定义）→ 无依赖，立即执行
任务 2（SessionContext）→ 依赖任务 1
任务 3（PromptEngine）→ 依赖任务 1
任务 4（Compaction）→ 依赖任务 1
任务 5（Client 透传）→ 依赖任务 3
任务 6（AgentLoop 切换）→ 依赖任务 2 + 3 + 4 + 5（关键路径）
任务 7（TUI 适配）→ 依赖任务 6
任务 8（删除旧代码）→ 依赖任务 6 + 7（Phase 5 检查点后）
任务 9（测试更新）→ 与任务 6-8 并行进行
```

**关键路径**：1 → 2/3/4 并行 → 5 → 6 → 检查点 → 7/8/9

**预计工时**：
- Phase 1-2：0.5 天
- Phase 3-4：1 天
- Phase 5（检查点）：0.5 天验证
- Phase 5 续（删除 + 测试更新）：1-1.5 天
- **总计：3-4 天**

---

## 与 Artifact Log 计划的关系

本计划与 `2026-05-22-append-only-artifact-log.md` 是**独立的**，可以并行或串行执行：

- Artifact Log 改的是 tool output 的内容（全文 → 摘要引用）
- 本计划改的是 message 的格式（Anthropic blocks → OpenAI messages）
- 两者不冲突：artifact ref 在 OpenAI 格式中就是 `{ role: 'tool', content: '[artifact:xxx] summary...' }`

**建议执行顺序**：先完成本计划（格式统一），再做 Artifact Log（内容优化）。因为 Artifact Log 的验证脚本需要用 engine.buildRequest 的输出直接发 API——格式统一后这变得自然。

---

## 修订与补丁（2026-05-22 · 天权 audit）

> Opus 4.6 这一面在 isolated worktree `feat/openai-native-format-migration` 上对本 plan 做了一次架构层称量。下列补丁**不重写**上方内容（遵守 canonical memory Invariant 3 — append-only），是对上方任务的**修正与增补**。任何与上方原文冲突之处，以本节为准。

### A · 文件数估算偏高

实测（`grep -rln "ContentBlockToolUse\|ContentBlockToolResult\|tool_use_id" src/`）：

- **10 个源文件**（plan 估 ~35）
- **13 个测试文件**（plan 估 ~30）
- 总计 23 个，不是 65 个

工时 3-4 天保留，但**多余时间用于每个 Phase 的 cache 验证**（见 B 项）。

### B · 每个 Phase 必须 cache 验证才能 commit（关键）

原 acceptance criteria 只在最末验证 cache hit。这不够——任何中间 Phase 引入字节差异（JSON key 顺序、stableStringify 漏调用、消息结构改变）都会到最末才发现。

**强制要求** — 每个 Phase 提交前必须：

1. 跑 `scripts/verify-task-a-multi-tool.ts` N≥3 次
2. 跑 `scripts/verify-task-b-session-state.ts` N≥3 次
3. 跑 `scripts/verify-task-c-fresh-boundary.ts` N≥3 次
4. Recent 3 turns 平均命中率 vs **基线 cache 测量结果**，差值绝对值 ≤ 5%
5. 任何 Phase 出现 > 5% 下降 → 回滚该 Phase，根因分析

基线测量在 Phase 1 开始**之前**完成，记录在文末"基线 cache 测量结果"。

### C · Verify 脚本的 sessionState 注入位置必须先修正（critical）

**当前 verify 脚本（A/B/C）注入到 system message**：

```ts
const system = `${SYSTEM_BASE}\n\n${stateBlock}`
```

**Rivet 实际生产代码注入到 volatile dynamic appendix**：

- `loop.ts:925` → `promptEngine.setSessionState(sessionStateManager.renderForVolatile())`
- `engine.ts` 存为 `sessionStateText`
- `volatile.ts:42-48` 注释（设计契约）：
  > Cache-safe: rendered ONLY into the dynamic appendix of the latest user message. MUST stay out of buildVolatileBlockInternal so historical user messages keep their frozen prefix byte-stable across tool-call turns.
- `volatile.ts:213-215` → 进入 `<context-update>` 块，附在 latest user message 之后

**后果**：当前 verify 脚本测的是 "OAI native + state-in-system" 模式，**和 Rivet 实际行为不一致**。state 增长 → system 改变 → system anchor cache miss。Rivet 不会出现这种 miss。

**Patch**：迁移开始前（即基线测量之前），三个 verify 脚本改为：

- system 保持 stable（只 `SYSTEM_BASE`，**不**拼 sessionState）
- sessionState 包成 `<context-update>...</context-update>` XML 块
- 作为独立 user message 插入到对话**最后一条 user message 之前**（与 `engine.ts` 的 FRESH volatile 注入位置一致）

修正前测的数据**不能作基线**。

### D · Phase 2 单一存储，不要双格式

原 Task 2 让 SessionContext 同时存 `OaiMessage[]` 和 legacy `Message[]`，靠 `syncLegacyFromOai` / `syncLegacyToolResults` 同步副本。

**问题**：

- 内存翻倍——与 `2026-05-21-memory-safety-three-lines-design.md` 立的 RSS 510MB 红线冲突
- 同步逻辑漂移 → 不同消费者看到不同历史
- 是"约定形式的同步"，违反 canonical memory invariants 精神（**约束 > 约定**）

**Patch**：单一权威存储（OAI），`getMessages()` 改为 **on-demand computed property**：

```ts
/** Legacy view — converts on read, no duplicated state. */
getMessages(): Message[] {
  return this.state.oaiMessages.map(convertOaiToLegacy)
}

getOaiMessages(): OaiMessage[] {
  return this.state.oaiMessages
}
```

`convertOaiToLegacy` 是 Phase 1 `migrateMessageToOai` 的逆映射，**写在同一个文件**，保证可逆 + round-trip 测试。

### E · Phase 1 必须包含 Provider × Thinking 矩阵

转换层有三个 provider-specific 边界条件（openai-client.ts buildRequestBody 已实现）：

- DeepSeek 要求 `reasoning_content` 在 tool-call 回合传回
- GLM `clear_thinking=true` → 跳过 `reasoning_content`（省 200K 上下文）
- Thinking-only assistant 必须有 placeholder `content`（否则 OpenAI 400）

**Patch**：Phase 1 在任务 1 后新增 **任务 1.5：Provider × Thinking 矩阵**。

| Provider | thinking | text | tool_calls | 期望产出 |
|----------|---------|------|-----------|---------|
| DeepSeek | ✓ | ✓ | ✓ | content + reasoning_content + tool_calls |
| DeepSeek | ✓ | ✗ | ✓ | content='' + reasoning_content + tool_calls |
| DeepSeek | ✓ | ✗ | ✗ | content='' + reasoning_content |
| GLM | ✓ | ✓ | ✓ | content + tool_calls（跳过 reasoning_content） |
| GLM | ✓ | ✗ | ✓ | content='' + tool_calls |
| Codex | （per Codex Responses API 行为） | ... | ... | 见 G 项专审 |
| OAI-compat 标准 | ✗ | ✓ | ✓ | content + tool_calls |

每格一个测试，验证 `buildOaiRequest` 输出符合期望。

**当前状态（2026-05-22）**：`buildOaiRequest` 尚未实现，已先在 `src/api/__tests__/openai-client.test.ts` 锁定现有 `openai-client.buildRequestBody` 的 provider × thinking 行为，作为迁移前兼容基准：

- [x] DeepSeek: thinking + text + tool_calls → `content` + `reasoning_content` + `tool_calls`
- [x] DeepSeek: thinking + no text + tool_calls → no `content` + `reasoning_content` + `tool_calls`（现有行为；Phase 3 `buildOaiRequest` 可再决定是否统一为 `content: ''`）
- [x] DeepSeek: thinking-only → `content: ''` + `reasoning_content`
- [x] GLM: thinking + text + tool_calls → `content` + `tool_calls`，跳过 `reasoning_content`
- [x] GLM: thinking + no text + tool_calls → no `content` + `tool_calls`，跳过 `reasoning_content`
- [x] OAI-compatible standard: text + tool_calls → `content` + `tool_calls`，无 `reasoning_content`

Phase 3 新增 `buildOaiRequest` 后，需把上述锁定测试迁移/复制到新路径，并按最终 OpenAI-native 规范确认 tool-call-only assistant 是否要求显式 `content: ''`。

### F · Hook pipeline 必须先审计

Rivet 9 个 runtime hook（`signal-consumer`, `perception`, `vigor`, `theta`, `kick`, `stigmergy`, `playbook-reflect`, `dream`, `telemetry-flush`）的实现没在原 plan 中列。若任何 hook 迭代 `content as ContentBlock[]` 找 `tool_use` / `tool_result`，迁移中静默坏。

**Patch**：Phase 1 任务 0（迁移前置）新增：

- [x] 审计 `src/agent/hooks/*.ts` 中所有对 message content 的迭代
- [x] 列出每个 hook 对 message 格式的依赖（即使没有依赖也明确记录"无"）
- [x] Phase 4 切换时，有依赖的 hook 同步更新

`dream.ts` 已 grep 确认无 ContentBlock 依赖。剩 8 个 hook 未查。

**审计结果（2026-05-22）**：

| Hook | 文件 | message 格式依赖 | 证据 / Phase 4 行动 |
|------|------|------------------|---------------------|
| signal-consumer | `src/agent/hooks/signal-consumer-hook.ts` | 无直接依赖 | 只读取 `ctx.snapshot.strategy` / `sensoriumInput`，通过 `ctx.effects.injectUserMessage(...)` 注入元提示；不读取历史 messages/content blocks。Phase 4 无需同步改动。 |
| perception | `src/agent/hooks/perception-hook.ts` | 无 | 只根据 `sensoriumInput` 计算 `Sensorium` / `Strategy`；不读取消息历史。Phase 4 无需同步改动。 |
| vigor | `src/agent/hooks/vigor-hook.ts` | 无直接依赖 | `postTool` 只使用 `RuntimeToolEvent` 与 `PredictionAccumulator`；`afterPerception` 只调制 strategy；不读取消息 content。Phase 4 无需同步改动。 |
| theta | `src/agent/hooks/theta-hook.ts` | 无 | 只推进 `ThetaState` 并在复杂度阈值满足时 `requestThetaCheck`；不读取消息历史。Phase 4 无需同步改动。 |
| kick | `src/agent/hooks/kick-hook.ts` | 无直接依赖 | 使用 `ctx.snapshot.recentToolHistory` 的 `{ tool, target, status }` 摘要构建 kick actions；不读取 `Message.content` / `ContentBlock[]`。Phase 4 仅需确认 `recentToolHistory` 仍稳定供给。 |
| stigmergy | `src/agent/hooks/stigmergy-hook.ts` | 无直接依赖 | 使用 `RuntimeToolEvent`、`recentToolHistory`、evidence verifications 与 pheromone store；不读取消息 blocks。Phase 4 仅需确认 tool history 摘要不受消息格式切换影响。 |
| playbook-reflect | `src/agent/hooks/playbook-reflect-hook.ts` | 间接依赖 | hook 本身不读取 messages，但调用 `deps.buildRetrospectInput()`；Phase 4 需审计该 dependency 的构造处是否从 legacy messages 派生 retrospect input。 |
| dream | `src/agent/hooks/dream-hook.ts` | 无 | 使用 evidence、decisions、trajectory 持久化 dream；已确认无 ContentBlock 依赖。Phase 4 无需同步改动。 |
| telemetry-flush | `src/agent/hooks/telemetry-flush-hook.ts` | 无 | 只调用 `writer.flush()`；不读取消息历史。Phase 4 无需同步改动。 |

**额外发现**：`src/agent/hooks/` 目录实际还有非原 9 个 hook：`radio-hook.ts`、`courage-hook.ts`、`consistency-check-hook.ts`、`cross-session-hook.ts`、`dispatcher-hook.ts`。审计结论：均无 legacy ContentBlock 直接依赖；其中 `radio` / `courage` 使用 `recentToolHistory` 摘要，`cross-session` 注入 dynamic appendix 字符串，`consistency-check` 使用 tool event target，`dispatcher` 使用 task contract / sensorium。Phase 4 只需保持 runtime snapshot/effects API 兼容。

### G · Codex client 不能一行带过

CLAUDE.md 明文：
> Codex client receives text via both `output_text.delta` and `output_item.done` — `seenTextDelta` dedup handles this

Codex 走的是 Responses API（`output_item` / `output_text.delta`），不是标准 ChatCompletions，有 dedup 逻辑。

**Patch**：Task 5 扩展为：

- [ ] 审查 codex-client.ts 中 `seenTextDelta` dedup 逻辑对 OAI 内部格式的依赖
- [ ] 验证 Responses API → OaiMessage 的映射（**不一定 1:1**）
- [ ] 单独 cache hit 验证（Codex/OpenAI 的 cache 语义不同于 DeepSeek，可能需要独立 verify 脚本）

### H · CTCL sanitizer 独立 cache 验证

`src/agent/ctcl-sanitizer.ts:36` 有 field alias `tool_use_id: ['toolUseId', 'toolCallId', 'callId', 'id']`。CTCL 是 cache preservation 层，sanitizer 改动直接影响 cache 安全。

**Patch**：Phase 5 中 ctcl-sanitizer 改动**单独 commit**，commit 前三个 verify 脚本 N≥3 次 + 基线对比。

### I · Phase 3-4 期间双路径 A/B sanity

Phase 3-4 是 `buildRequest`（旧）和 `buildOaiRequest`（新）共存窗口。利用这个窗口做字节稳定性探针：

**Patch**：Phase 3 task 1 后新增"双路径 sanity"步骤——

- 同一份逻辑 messages
- 旧路径产 request body A，新路径产 request body B
- `stableStringify(A)` vs `stableStringify(B)` → diff
- **字节一致才能进入 Phase 4**

把"我们测不出 cache"反转成"用 cache 测自己"——迁移本身就是字节稳定性探针。

### J · Phase 5 "不可回滚" 的真实语义

原文"Phase 5 不可回滚——旧类型已删除"技术上不准确（git revert 仍可回滚）。**Patch** 改为：

> Phase 5 之后回滚成本陡升——需要重新实现 Anthropic↔OAI 转换层（~85 行 + 3 个 provider 边界）+ 改 13 个测试。Phase 4 完成且通过下列检查点前**禁止**开始 Phase 5：
> 1. 全量测试通过（startup-memory 等已知 baseline 失败除外）
> 2. 三个 verify 脚本 N≥3 次 cache hit 与基线差值 ≤5%
> 3. Codex client 单独验证通过（G 项）
> 4. CTCL sanitizer 单独验证通过（H 项）
> 5. Hook 审计完成 + 涉及 hook 已更新（F 项）

### K · 已知 baseline 失败的归类

进入 worktree 时基线 `npm test` 1 个失败（理论上 2 个，theta-check 这次跑过）：

- `src/__tests__/startup-memory.test.ts` — RSS 200MB > 115MB budget。**归因明确**：阈值来自 star-soul 遗珠 commit f6e1614（`perf(startup): lazy-load`, RSS 134→98MB, -27%），2.5 没有该 commit。**不在本 plan 范围内修**——遗珠引回是独立工作流（见 `session-retro-2026-05-21-shoushu.md` § 三 遗珠清单）。
- `src/agent/__tests__/theta-check.test.ts` — 本次 worktree 跑通过 5/5。可能是 flaky 或本次环境差异。**继续监控**。

---

## 基线 cache 测量结果（已填写）

> 由人类操作者在 Phase 1 开始**之前**、Verify 脚本完成 Patch C 修正**之后**，用真实 `DEEPSEEK_API_KEY` 跑下列命令。基线是后续每个 Phase 验证的对照。
>
> 基线原始记录已复制到 `docs/cache-baseline/缓存验证 t1.md`（来源：`/Users/banxia/app/deepseek-tui/docs/缓存验证 t1-t3-jixian`）。

```bash
DEEPSEEK_API_KEY=sk-xxx ./node_modules/.bin/tsx scripts/verify-task-a-multi-tool.ts
DEEPSEEK_API_KEY=sk-xxx ./node_modules/.bin/tsx scripts/verify-task-b-session-state.ts
DEEPSEEK_API_KEY=sk-xxx ./node_modules/.bin/tsx scripts/verify-task-c-fresh-boundary.ts
```

| 脚本 | Run 1 | Run 2 | Run 3 | 中位数 | 最低值 | 日期 / 操作者 |
|------|-------|-------|-------|--------|--------|--------------|
| verify-task-a (Recent 3 avg) | 84.3% | 93.3% | 92.6% | 92.6% | 84.3% | 2026-05-22 / 人类操作者 |
| verify-task-b (Recent 3 avg) | 93.8% | 93.4% | 91.8% | 93.4% | 91.8% | 2026-05-22 / 人类操作者 |
| verify-task-c phase1 last turn | 92.0% | 92.2% | 80.2% | 92.0% | 80.2% | 2026-05-22 / 人类操作者 |
| verify-task-c phase2 first turn | 93.5% | 89.5% | 93.3% | 93.3% | 89.5% | 2026-05-22 / 人类操作者 |

**取值规则**：后续 Phase 对比时使用"最低值"列（最 conservative），避免单次幸运掩盖回归。

**基线备注**：原始记录中 verify-task-a 另有第 4 轮 Recent 3 avg = 92.0%，为超额补充样本；基线表按天权要求仅记录前三轮。

---

## 修订历史

- **2026-05-21** · 原 plan 起草（领航星 / DeepSeek 天权 native engine）
- **2026-05-22** · 天权 Opus 4.6 创始之面 audit 后补丁 A–K + 基线测量框架 + verify 脚本修正要求 + 已知 baseline 失败归类
