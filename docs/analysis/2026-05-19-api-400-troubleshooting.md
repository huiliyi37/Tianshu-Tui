# API 排障记录：v4-flash web_search 400 + v4-pro 空 assistant 400

> 日期：2026-05-19
> 分支：feat/tui-2.4-structural-maturity
> 提交：a28de63, bc787fc

---

## 1. 问题 A：v4-flash `Invalid schema for function 'web_search'`

### 现象

```
Error: API error 400: {"error":{"message":"Invalid schema for function 'web_search': null is not of types \"boolean\", \"object\"","type":"invalid_request_error"}}
```

使用 `deepseek-v4-flash` 模型时，首次请求就返回 400。

### 根因分析

**两个客户端都有漏洞：**

| 客户端 | 文件 | 问题 |
|--------|------|------|
| `OpenAIClient` | `src/api/openai-client.ts:307` | ✅ 已有过滤：非 GLM provider 移除 `providerFormat` tools |
| `ApiClient` | `src/api/client.ts:179` | ❌ **没有过滤**：直接将所有 tools 发送给 API |

`web_search` 工具定义在 `src/tools/web-search.ts`：

```ts
{
  name: 'web_search',
  providerFormat: {              // ← GLM 专用格式
    type: 'web_search',
    web_search: { enable: true, ... }
  }
  // 没有 input_schema！
}
```

当用户的 `~/.rivet/config.json` 中 DeepSeek 配置为 `protocol: "anthropic"`（通过 `api.deepseek.com/anthropic` 代理）时，请求走 `ApiClient`（Anthropic 协议），而 `ApiClient` 没有 `providerFormat` 过滤逻辑，导致 GLM 专用的 `web_search` 定义被发送给 DeepSeek API。

### 修复

**commit bc787fc**：`src/api/client.ts` 中过滤 `providerFormat` tools：

```ts
const filteredTools = request.tools?.filter(t => !t.providerFormat)
```

### 附带修复：用户配置还原

用户 `~/.rivet/config.json` 中 DeepSeek 的 `baseUrl` 被改回了 `api.deepseek.com/anthropic`（Anthropic 协议），但之前 commit 8024f64 已经迁移到了 `api.deepseek.com/v1`（OpenAI 协议）。

手动将用户配置还原为 OpenAI 协议：
- `baseUrl`: `https://api.deepseek.com/v1`
- `protocol`: `openai`

这样 DeepSeek 请求走 `OpenAIClient`（已有 providerFormat 过滤），问题彻底解决。

---

## 2. 问题 B：v4-pro `Invalid assistant message: content or tool_calls must be set`

### 现象

```
Error: OpenAI API error (invalid_request_error): Invalid assistant message: content or tool_calls must be set
```

使用 `deepseek-v4-pro` 模型，第二轮请求时返回 400。

### 根因分析

`OpenAIClient.buildRequestBody()` 构建 assistant 消息时：

```ts
const assistant: Record<string, unknown> = { role: 'assistant' }
if (textParts.length > 0) {
  assistant.content = textParts.join('')
}
if (thinkingParts.length > 0) {
  assistant.reasoning_content = thinkingParts.join('')
}
if (toolCalls.length > 0) {
  assistant.tool_calls = toolCalls
}
messages.push(assistant)  // ← 可能 content 和 tool_calls 都是 undefined！
```

**触发场景**：当模型某一轮只返回了 `reasoning_content`（思考过程），但没有文本内容也没有 tool 调用时：

- `textParts = []`
- `toolCalls = []`
- `thinkingParts = ["思考内容..."]`

此时 `assistant = { role: 'assistant', reasoning_content: '...' }`，没有 `content` 也没有 `tool_calls`。DeepSeek OpenAI API 要求每条 assistant 消息必须有 `content` 或 `tool_calls` 之一，因此返回 400。

### 修复

**commit a28de63**：在 `messages.push(assistant)` 前加守卫：

```ts
if (!assistant.content && !assistant.tool_calls) {
  assistant.content = ''
}
messages.push(assistant)
```

空字符串 `content` 对 OpenAI API 是合法的，不会影响模型行为。

---

## 3. 教训

| 教训 | 详情 |
|------|------|
| **多客户端一致性** | `OpenAIClient` 和 `ApiClient` 是两个独立的客户端实现，任何过滤/转换逻辑需要在两边都加 |
| **用户配置漂移** | 代码默认值（`default.ts`）和用户配置文件（`~/.rivet/config.json`）可能不一致。迁移后用户配置可能被其他工具/手动编辑覆盖回去 |
| **OpenAI API 不认 reasoning_content** | `reasoning_content` 是 DeepSeek 扩展字段，不算作 `content`。当 thinking-only 轮次被回传时，API 认为消息是空的 |
| **debug 400 的关键路径** | 错误消息中包含 `function 'web_search'` → 直接指向工具定义问题。`Invalid assistant message` → 指向消息构建问题 |

## 4. 相关文件

| 文件 | 变更 |
|------|------|
| `src/api/openai-client.ts` | assistant 消息空 content 守卫 + schema 改进 |
| `src/api/client.ts` | providerFormat 过滤 |
| `src/api/types.ts` | `additionalProperties` 类型支持 |
| `src/tools/web-search.ts` | 未改 — 问题在消费端 |
| `~/.rivet/config.json` | DeepSeek protocol 还原为 openai |
