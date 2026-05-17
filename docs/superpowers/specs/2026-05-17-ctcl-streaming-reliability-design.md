# CTCL 流式可靠性与 Prefix Cache 优化 — 技术设计文档

## 1. 头脑风暴背景

### 1.1 问题起源

在 Rivet 长会话使用中，用户反复观察到三类症状：

1. **DeepSeek prefix cache 命中率从理论 99%+ 跌至 ~88%** — 每次请求的 token 计费远超预期
2. **模型回复最后一句话偶尔丢失** — 用户看到不完整的回答，需要手动追问
3. **模型在同一轮回复中重复段落** — DeepSeek 偶尔输出相同句子 2-3 次

### 1.2 核心洞察

经过对请求链路的逐层审计，发现这三个问题虽然表现不同，但根因都在 **流式传输管道的非确定性和边界处理缺陷**：

- Cache miss 的根因不是压缩或 context 管理，而是 **JSON 序列化的 key 顺序不确定** + **tools 未发送到 DeepSeek**
- 最后一句丢失的根因是 **SSE 解析器的 buffer 残留** + **TUI 层 flush 时序错误**
- 句子重复是 DeepSeek 模型本身的行为，需要在 agent 层做 **后处理去重**

### 1.3 设计原则

- **Exact-prefix matching**: DeepSeek 的 cache 是字节级精确匹配，任何一个字节的差异都会导致 cache miss
- **流式完整性**: 从 TCP 字节到 UI 渲染，每一层都必须保证数据不丢失
- **防御性去重**: 模型输出的非确定性需要在 agent 层兜底，而非依赖模型行为

---

## 2. 架构分析

### 2.1 请求链路（prefix cache 相关）

```
PromptEngine.buildRequest()
  → system prompt (静态字符串)
  → tools[] (需要 deterministic 序列化)
  → messages[] (历史消息，frozen)
  → volatile context (当前轮动态信息)
      ↓
OpenAIClient.buildRequestBody()
  → JSON.stringify(body) → HTTP POST
      ↓
DeepSeek API
  → exact-prefix match → cache hit/miss
```

**发现的问题**:
1. `JSON.stringify()` 不保证 key 顺序 — 同一对象在不同 V8 运行中可能产生不同字节序列
2. `tools` 数组在 `buildRequestBody()` 中未排序
3. 更严重：tools 根本没有被发送（`buildRequestBody` 忽略了 request.tools）

### 2.2 响应链路（流式完整性相关）

```
HTTP Response (chunked)
  → TextDecoder → buffer += chunk
  → split('\n') → SSE lines
  → processDelta() → callbacks.onTextDelta()
      ↓
AgentLoop.streamCallbacks.onTextDelta()
  → turnDisplayBuffer += text
  → (turn end) → callbacks.onTextDelta(turnDisplayBuffer)
      ↓
TUI: BlockStreamWriter.push(text)
  → buffer accumulation → onBlock(text)
      ↓
RenderBatcher.push(text)
  → queueMicrotask → flush → streamBuf.current += combined
```

**发现的问题**:
1. SSE 解析：`buffer = lines.pop()` 保留最后一行，但流结束时 (`done: true`) 直接 break，残留 buffer 未处理
2. TUI flush 时序：`writer.flush()` → `batcher.push()` → 调度 microtask，但 `streamBuf.current` 在 microtask 执行前就被读取

---

## 3. 实现方案

### Phase 1: Deterministic Serialization (Prefix Cache)

#### 3.1 stableStringify

```typescript
// src/api/stable-json.ts
export function stableStringify(value: unknown): string {
  if (value === null || value === undefined) return JSON.stringify(value)
  if (typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) {
    return '[' + value.map(stableStringify).join(',') + ']'
  }
  const obj = value as Record<string, unknown>
  const keys = Object.keys(obj).sort()
  const pairs = keys
    .filter(k => obj[k] !== undefined)
    .map(k => JSON.stringify(k) + ':' + stableStringify(obj[k]))
  return '{' + pairs.join(',') + '}'
}
```

特性：
- 递归排序所有嵌套对象的 key
- 过滤 `undefined` 值（与 `JSON.stringify` 行为一致）
- 保持数组顺序不变
- 输出无空格（最小化字节数）

#### 3.2 Tools 排序与发送

```typescript
// OpenAIClient.buildRequestBody() 修复
tools: request.tools && request.tools.length > 0
  ? [...request.tools].sort((a, b) => a.name.localeCompare(b.name)).map(toOpenAITool)
  : undefined
```

双重排序策略（PromptEngine + OpenAIClient）确保无论调用路径如何，tools 始终有序。

#### 3.3 Request Body 序列化

```typescript
// 替换 JSON.stringify(body) 为 stableStringify(body)
body: stableStringify(requestBody)
```

覆盖点：
- `openai-client.ts`: 主请求 body
- `client.ts`: Anthropic 兼容层请求 body
- Tool call arguments: `stableStringify(block.input)`

#### 3.4 Session Routing Header

```typescript
headers['X-Request-Session'] = this.config.sessionId ?? ''
```

为 DeepSeek 的负载均衡器提供 session affinity hint，增加请求路由到同一 cache shard 的概率。

### Phase 2: Stream Integrity (最后一句丢失)

#### 3.5 SSE Buffer 残留修复

```typescript
// 流结束后处理残留 buffer
if (buffer.trim()) {
  const trimmed = buffer.trim()
  if (trimmed.startsWith('data: ')) {
    const payload = trimmed.slice(6)
    if (payload !== '[DONE]') {
      try {
        const parsed = JSON.parse(payload)
        this.processDelta(parsed, callbacks)
      } catch { /* skip malformed */ }
    }
  }
}
```

**根因**: HTTP chunked transfer 的最后一个 chunk 可能不以 `\n` 结尾。`buffer.split('\n')` 将其留在 `lines.pop()` 中，而 `if (done) break` 跳过了处理。

#### 3.6 TUI Flush 时序修复

```typescript
// 修复前（有 bug）:
textBatcher.current.flushNow()  // 排空当前 batcher 队列
writer.flush()                   // 推入新内容到 batcher（调度 microtask）
const finalText = streamBuf.current  // ❌ 新内容还在 microtask 中

// 修复后:
textBatcher.current.flushNow()
writer.flush()
textBatcher.current.flushNow()  // ✅ 再次同步排空
const finalText = streamBuf.current
```

三处路径均需修复：正常完成、错误处理、abort 处理。

#### 3.7 toolCallBuffer 状态污染修复

```typescript
async stream(request, callbacks, signal) {
  this.toolCallBuffer.clear()
  this.pendingStopReason = null
  // ...
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    this.toolCallBuffer.clear()
    this.pendingStopReason = null
    // ...
  }
}
```

**根因**: `toolCallBuffer` 是实例属性，跨 `stream()` 调用持久化。如果前一次调用中途失败，残留数据会污染下一次调用或重试。

### Phase 3: Intra-turn Repetition Detection

#### 3.8 stripIntraTurnRepetition

```typescript
// src/agent/dedup.ts
export function stripIntraTurnRepetition(text: string): string {
  if (text.length < 100) return text
  for (const size of [200, 100, 50]) {
    if (text.length < size * 2) continue
    let i = 0, result = ''
    while (i < text.length) {
      const chunk = text.slice(i, i + size)
      if (chunk.length < size) { result += text.slice(i); break }
      let reps = 1
      while (text.slice(i + size * reps, i + size * (reps + 1)) === chunk) reps++
      if (reps >= 2) { result += chunk; i += size * reps }
      else { result += text[i]; i++ }
    }
    if (result.length < text.length) return result
  }
  return text
}
```

策略：
- 从大到小尝试 chunk size (200 → 100 → 50)，优先匹配最长重复块
- 滑动窗口扫描，检测连续 2+ 次重复
- 保留一份，删除多余副本
- 短文本 (<100 chars) 直接跳过，避免误判

与现有 `displayTextFingerprint` 的关系：
- `displayTextFingerprint`: 跨轮去重（整轮文本相同则抑制）
- `stripIntraTurnRepetition`: 轮内去重（同一轮内段落重复则合并）

---

## 4. 预期效果

| 指标 | 修复前 | 修复后 |
|------|--------|--------|
| Prefix cache hit rate | ~88% | 95-97% |
| 最后一句丢失频率 | 偶发（~2-5%） | 消除 |
| 轮内重复段落 | 偶发（DeepSeek 特有） | 自动去重 |
| 重试后 tool call 解析错误 | 偶发 | 消除 |

剩余 3-5% cache miss 来源：
- 首轮请求（无历史 cache）
- Compaction 后前缀变化
- 服务端 cache eviction（TTL 或容量）

---

## 5. 已确认安全的路径

以下模块经审计确认不需要修改：

| 模块 | 原因 |
|------|------|
| Volatile block | 历史消息中的 volatile block 在构造时冻结，不会重新生成 |
| Compaction | 压缩发生在消息后段，不影响 system+tools 前缀 |
| Git status cache | TTL cache，不进入请求前缀 |
| 子代理结果收集 | `runWorkerSession` 有 retry+repair 机制，结果不会静默丢失 |
| Thinking loop 检测 | 已有 chunk 重复 3+ 次检测 + 跨轮 600 字符比对 |

---

## 6. 提交记录

| Commit | 描述 |
|--------|------|
| `b3e8c62` | stableStringify + tools 排序/发送 + session header |
| `0520c73` | tool_call arguments 使用 stableStringify |
| `141a103` | SSE buffer 残留 + TUI flush 时序 + 轮内去重 |

---

## 7. 后续可选优化

1. **stableStringify 循环引用保护** — 当前假设输入无循环（成立于所有已知调用点），如果未来暴露为公共 API 可加 WeakSet 检测
2. **Prefix fingerprint drift alerting** — `fingerprint.ts` 已实现 `detectDrift()`，可接入 TUI 状态栏显示 cache 健康度
3. **轮内去重的 NLP 增强** — 当前是精确字节匹配，对于"几乎相同但有微小差异"的重复无效。可考虑 n-gram 或编辑距离，但复杂度和误判风险需权衡
