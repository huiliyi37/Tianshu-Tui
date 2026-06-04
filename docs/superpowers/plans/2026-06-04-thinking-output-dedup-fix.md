# Thinking 重复输出与内容泄漏修复计划

> **创建时间：** 2026-06-04
> **严重级别：** P1 — 影响用户体验，内容泄漏到可见输出
> **影响范围：** MiMo、DeepSeek 等使用 reasoning_content 的 provider

---

## 1. 问题描述

### 症状（来自 MiMo 会话日志）

1. **Thinking 内容泄漏到可见输出**：模型的内部推理（如 "Hmm, git log --since is exclusive..."）出现在 TUI 的文本输出区域，而非 thinking 面板
2. **重复输出**：相同的总结内容在输出中出现两次（一次截断，一次完整）
3. **工具调用过度重复**：执行了 8+ 次高度重叠的 git log 命令，实际只需 2-3 次

### 关键日志片段

```
┊ Thinking (63 chars)
│ macOS grep doesn't support -P. Let me use a different approach.

▍ Rivet
   Hmm, git log --since is exclusive, so "since 2026-06-04" means after June 4.
   Let me adjust.Now I have a good picture of what's been happening...
```

"Rivet" 区域显示的是 **可见文本输出**，但内容明显是内部推理。

---

## 2. 根因分析

### 根因 1：GLM-5.1 Thinking Promotion 误触发

**文件：** `src/api/openai-client.ts:420-426`

```typescript
// GLM-5.1 mandatory thinking: if only reasoning_content arrived (no content),
// promote reasoning to visible text so the TUI shows a reply.
if (!textReceived && reasoningAccum) {
  callbacks.onTextDelta?.(reasoningAccum)
  promotionFired = true
}
```

这段代码是为 GLM-5.1 设计的——GLM 的 mandatory thinking 模式只发送 `reasoning_content`，不发送 `content`。但这段逻辑对 **所有 provider** 生效，包括 MiMo。

**触发条件：** 当 MiMo 在某个 turn 只发送 `reasoning_content`（没有 `content`）时——例如模型在思考后决定调用工具，但 API 响应中 thinking 和 content 分开发送——promotion 就会触发，把 thinking 内容当作可见文本输出。

**为什么以前正常：** 以前 MiMo 可能在同一个 SSE chunk 中同时发送 `reasoning_content` 和 `content`，所以 `textReceived` 为 true，promotion 不触发。MiMo API 行为变化（或网络分包变化）导致 `reasoning_content` 和 `content` 出现在不同的 turn 中。

### 根因 2：Text Dedup 只做跨 Turn 比较

**文件：** `src/agent/loop.ts:1438-1478`

文本去重逻辑：
- 缓冲当前 turn 的文本
- 与上一个 turn 的 fingerprint 比较
- 如果相同则抑制

**问题：** 如果模型在 **同一个 turn** 内生成两次相同文本（例如一次在 thinking 中，一次在 content 中），去重不会生效。而且如果模型在连续两个 turn 中生成 **相似但不完全相同** 的文本（如相同的总结但措辞略有不同），也不会被抑制。

### 根因 3：Thinking Retry 可能导致重复

**文件：** `src/agent/thinking-retry.ts`

```typescript
if (streamedText.length > 0 || collectedBlockCount > 0 || thinkingOnlyRetries >= 1) {
  return { shouldRetry: false, ... }
}
```

当模型只产生 thinking（没有 text 和 tool calls）时，会重试并发送 "Please respond directly without additional thinking"。如果重试后模型输出了与之前 thinking 相同的内容，就会出现重复。

### 根因 4：MiMo systemSuffix 可能诱导模型输出推理

**文件：** `src/api/openai-client.ts:73-76`

```typescript
this.systemSuffix = (config.providerName === 'mimo' || config.providerName === 'deepseek') && config.thinking === 'enabled'
  ? '\n\nPlease think and reason in Chinese (中文) during your internal chain of thought.'
  : ''
```

"internal chain of thought" 的表述可能被 MiMo 解释为"在回复中输出你的推理过程"，而非"在内部推理"。

---

## 3. 修复方案

### 修复 1：限制 Thinking Promotion 仅对 GLM 生效

**文件：** `src/api/openai-client.ts`
**优先级：** P0 — 直接修复内容泄漏

将 promotion 逻辑限定为仅 GLM provider：

```typescript
// GLM-5.1 mandatory thinking: if only reasoning_content arrived (no content),
// promote reasoning to visible text so the TUI shows a reply.
// ONLY fire for GLM — other providers (MiMo, DeepSeek) send proper content fields.
if (!textReceived && reasoningAccum && this.config.providerName === 'glm') {
  callbacks.onTextDelta?.(reasoningAccum)
  promotionFired = true
}
```

同样修改 `finally` 块中的 fallback：

```typescript
if (!textReceived && reasoningAccum && !promotionFired && this.config.providerName === 'glm') {
  callbacks.onTextDelta?.(reasoningAccum)
}
```

**风险：** 低。GLM 是唯一需要 promotion 的 provider。MiMo 和 DeepSeek 都有正常的 content 字段。

### 修复 2：加强 Text Dedup — 添加 within-turn 和近似匹配

**文件：** `src/agent/loop.ts`
**优先级：** P1 — 防止重复输出

在现有的跨 turn fingerprint 比较基础上，添加：

1. **Within-turn accumulation dedup**：如果当前 turn 的文本累积与已发送的文本高度重叠（>80% 相同），抑制重复部分
2. **近似 fingerprint 匹配**：使用 normalized fingerprint（去除空白、标点）进行比较

```typescript
onTextDelta: (text) => {
  turnTextAccum += text
  const fp = turnTextAccum.replace(/\s+/g, ' ').trim()
  
  // Existing cross-turn dedup
  if (prevFingerprint && fp === prevFingerprint) {
    return // suppress exact match
  }
  
  // NEW: within-turn accumulation dedup
  // If the model repeats itself within the same turn, suppress duplicates
  if (turnTextAccum.length > 200) {
    const half = turnTextAccum.slice(0, Math.floor(turnTextAccum.length / 2))
    const secondHalf = turnTextAccum.slice(Math.floor(turnTextAccum.length / 2))
    if (secondHalf.includes(half.slice(0, 100))) {
      // Detected repetition within turn — suppress further deltas
      return
    }
  }
  
  // Existing divergence check
  if (!prevFingerprint.startsWith(fp)) {
    turnDedupState = 'flushed'
    callbacks.onTextDelta(pendingFlush)
    pendingFlush = ''
  }
},
```

### 修复 3：优化 systemSuffix 表述

**文件：** `src/api/openai-client.ts`
**优先级：** P2 — 减少模型输出推理的倾向

```typescript
this.systemSuffix = (config.providerName === 'mimo' || config.providerName === 'deepseek') && config.thinking === 'enabled'
  ? '\n\n请在内部思考链中使用中文进行推理。不要在回复中输出你的推理过程。'
  : ''
```

或者保持英文但更明确：

```typescript
this.systemSuffix = (config.providerName === 'mimo' || config.providerName === 'deepseek') && config.thinking === 'enabled'
  ? '\n\nThink and reason in Chinese internally. Do NOT output your reasoning in the response — only output the final answer or tool calls.'
  : ''
```

### 修复 4：Thinking Retry 添加 fingerprint 检查

**文件：** `src/agent/thinking-retry.ts`
**优先级：** P2 — 防止重试导致重复

在重试前检查 thinking content 是否与上一个 turn 的 text 输出重叠：

```typescript
export interface ThinkingRetryInput {
  streamedText: string
  collectedBlockCount: number
  thinkingAccum: string
  thinkingOnlyRetries: number
  lastThinkingContent: string
  lastTurnTextFingerprint?: string  // NEW
}

// In evaluateThinkingRetry:
if (lastTurnTextFingerprint && thinkingAccum.length > 100) {
  const thinkingFp = thinkingAccum.replace(/\s+/g, ' ').trim().slice(0, 200)
  if (lastTurnTextFingerprint.includes(thinkingFp)) {
    // Thinking content matches previous text output — model is repeating itself
    return { shouldRetry: false, isLooping: true, ... }
  }
}
```

---

## 4. 验证方案

### 单元测试

1. **Thinking promotion 不对 MiMo 生效**
   - 模拟 MiMo SSE 流：只有 `reasoning_content`，没有 `content`
   - 验证 `onTextDelta` 不被调用
   - 模拟 GLM SSE 流：只有 `reasoning_content`
   - 验证 `onTextDelta` 被调用

2. **Within-turn text dedup**
   - 模拟模型在同一 turn 内输出两次相同文本
   - 验证第二次被抑制

3. **Thinking retry fingerprint 检查**
   - 模拟 thinking content 与上一个 turn 的 text 匹配
   - 验证不触发重试

### 集成测试

1. 使用 MiMo provider 运行完整 agent loop
2. 验证 thinking 内容不出现在可见输出中
3. 验证重复文本被抑制

### 手动验证

```bash
# 启动天枢，使用 MiMo provider
node dist/main.js --provider mimo

# 输入一个需要多步 git 操作的任务
# 观察：
# 1. Thinking 内容只在 thinking 面板显示
# 2. 文本输出不重复
# 3. 工具调用不过度重复
```

---

## 5. 实施顺序

| 顺序 | 修复项 | 优先级 | 预计工作量 | 风险 |
|------|--------|--------|-----------|------|
| 1 | 限制 Thinking Promotion 仅对 GLM 生效 | P0 | 15 min | 低 |
| 2 | 优化 systemSuffix 表述 | P2 | 5 min | 低 |
| 3 | 加强 Text Dedup | P1 | 30 min | 中 |
| 4 | Thinking Retry fingerprint 检查 | P2 | 20 min | 低 |

**建议：** 先做修复 1（最小改动，最大收益），验证是否解决问题。如果问题仍然存在，再做修复 3。

---

## 6. 结论

**这是代码问题，不是模型问题。** 证据：

1. 用户确认"以前有的版本都是正常的"——说明是回归
2. GLM-5.1 promotion 逻辑对所有 provider 生效，是设计缺陷
3. Text dedup 逻辑不够完善，无法处理 within-turn 重复
4. systemSuffix 表述可能诱导模型输出推理

修复 1（限制 promotion）是最关键的改动，应该立即实施。
