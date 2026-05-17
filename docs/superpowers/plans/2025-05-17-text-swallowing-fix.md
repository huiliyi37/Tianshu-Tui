# 终端回复被吞/截断修复 实施计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 修复多 turn 对话中回复文本被静默丢弃的 4 个 bug

**架构：** 给 onTurnComplete 回调加 isFinal 参数区分中间/最终 turn；重置跨 run 的去重状态；Codex client 加 delta 去重标记；修复 Ink wrap 截断。

**技术栈：** TypeScript, React (Ink), Node.js test runner

---

## 文件结构

| 文件 | 职责 | 变更类型 |
|------|------|----------|
| `src/agent/loop.ts` | Agent 循环主逻辑，管理 turn 迭代 | 修改 |
| `src/tui/app.tsx` | TUI 主组件，处理 onTurnComplete 回调 | 修改 |
| `src/tui/stream.tsx` | 流式文本渲染组件 | 修改 |
| `src/api/codex-client.ts` | Codex API SSE 客户端 | 修改 |
| `src/agent/__tests__/loop.test.ts` | Agent loop 多 turn 测试 | 修改 |
| `src/api/__tests__/codex-client.test.ts` | Codex client 测试 | 修改 |
| `src/tui/__tests__/stream-window.test.ts` | 流式窗口测试（验证无回归） | 不变 |

---

### 任务 1：修复 B2 — lastTurnText 跨 run() 不重置

**文件：**
- 修改：`src/agent/loop.ts:384` 附近（`run()` 方法开头）
- 修改：`src/agent/__tests__/loop.test.ts`

- [ ] **步骤 1：编写失败的测试**

在 `src/agent/__tests__/loop.test.ts` 末尾添加：

```typescript
it('does not suppress first-turn text when it matches previous run last turn', async () => {
  const session = new SessionContext()
  const registry = new ToolRegistry()
  registry.register(READ_FILE_TOOL)

  // Client always responds with same text
  const client: ApiClient = {
    stream: mock.fn(async (_req: unknown, cb: StreamCallbacks) => {
      cb.onTextDelta('Hello! How can I help?')
      cb.onContentBlock(makeTextBlock('Hello! How can I help?'))
      cb.onStopReason('end_turn', { input_tokens: 100, output_tokens: 50 })
    }),
  } as unknown as ApiClient

  const agent = new AgentLoop({
    client, promptEngine: makeEngine(), toolRegistry: registry,
    maxTurns: 5, contextWindow: 1_000_000,
    compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' },
  }, session, '/test')

  const texts1: string[] = []
  await agent.run('hello', {
    onTextDelta: (t) => texts1.push(t),
    onThinkingDelta: () => {},
    onToolUse: () => {},
    onToolResult: () => {},
    onTurnComplete: () => {},
    onError: (e) => { throw e },
    onAbort: () => {},
    onApprovalRequired: async () => false,
  })

  // Second run with identical response — should NOT be suppressed
  const texts2: string[] = []
  await agent.run('hello again', {
    onTextDelta: (t) => texts2.push(t),
    onThinkingDelta: () => {},
    onToolUse: () => {},
    onToolResult: () => {},
    onTurnComplete: () => {},
    onError: (e) => { throw e },
    onAbort: () => {},
    onApprovalRequired: async () => false,
  })

  assert.equal(texts1.join(''), 'Hello! How can I help?')
  assert.equal(texts2.join(''), 'Hello! How can I help?', 'Second run text should not be suppressed')
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npx tsx --test src/agent/__tests__/loop.test.ts`
预期：FAIL — `texts2` 为空（文本被 lastTurnText 去重抑制）

- [ ] **步骤 3：实现修复**

在 `src/agent/loop.ts` 的 `run()` 方法中，找到 `this.streamedText = ''`（约 line 436），在其前面添加：

```typescript
this.lastTurnText = ''
```

完整上下文（修改后）：

```typescript
// 在 run() 方法的 for 循环开始前，约 line 430 附近
this.lastTurnText = ''

// ... 现有代码 ...
for (let turn = 1; turn <= this.config.maxTurns; turn++) {
  this.streamedText = ''
```

注意：`this.lastTurnText = ''` 应该在 `for` 循环**外面**（run 方法开头），而 `this.streamedText = ''` 在循环**里面**。这样每次新的 `run()` 调用重置去重状态，但同一 run 内的多 turn 仍然保留去重能力。

- [ ] **步骤 4：运行测试验证通过**

运行：`npx tsx --test src/agent/__tests__/loop.test.ts`
预期：全部 PASS

- [ ] **步骤 5：Commit**

```bash
git add src/agent/loop.ts src/agent/__tests__/loop.test.ts
git commit -m "fix(agent): reset lastTurnText between run() calls — prevents cross-conversation text suppression"
```

---

### 任务 2：修复 B1 — onTurnComplete 区分中间/最终 turn

**文件：**
- 修改：`src/agent/loop.ts:77`（AgentCallbacks 类型定义）
- 修改：`src/agent/loop.ts:599`（中间 turn onTurnComplete 调用）
- 修改：`src/agent/loop.ts:642`（最终 turn onTurnComplete 调用）
- 修改：`src/tui/app.tsx:744`（onTurnComplete handler）
- 修改：`src/agent/__tests__/loop.test.ts`

- [ ] **步骤 1：修改 AgentCallbacks 类型**

在 `src/agent/loop.ts` 找到 `onTurnComplete` 类型定义（约 line 77）：

```typescript
// 修改前：
onTurnComplete: (usage: Partial<Usage>, turnNumber: number) => void

// 修改后：
onTurnComplete: (usage: Partial<Usage>, turnNumber: number, isFinal?: boolean) => void
```

- [ ] **步骤 2：修改中间 turn 的调用**

在 `src/agent/loop.ts` 找到 line 599（tool-use 分支的 onTurnComplete 调用）：

```typescript
// 修改前：
callbacks.onTurnComplete(this.session.getTotalUsage(), this.session.getTurnCount())

// 修改后：
callbacks.onTurnComplete(this.session.getTotalUsage(), this.session.getTurnCount(), false)
```

- [ ] **步骤 3：修改最终 turn 的调用**

在 `src/agent/loop.ts` 找到 line 642（最终 turn 的 onTurnComplete 调用）：

```typescript
// 修改前：
callbacks.onTurnComplete(this.session.getTotalUsage(), this.session.getTurnCount())

// 修改后：
callbacks.onTurnComplete(this.session.getTotalUsage(), this.session.getTurnCount(), true)
```

- [ ] **步骤 4：修改 TUI 的 onTurnComplete handler**

在 `src/tui/app.tsx` 找到 `onTurnComplete` handler（约 line 744）：

```typescript
// 修改前：
onTurnComplete: (_usage, turnNumber) => {

// 修改后：
onTurnComplete: (_usage, turnNumber, isFinal) => {
```

在 handler 开头（line 745 之后）添加早期返回逻辑：

```typescript
onTurnComplete: (_usage, turnNumber, isFinal) => {
  if (dirtyTools.current.size > 0) {
    flushTools()
  }

  // 中间 turn：只更新 activity/summary，不销毁 writer 或停止 streaming
  if (isFinal === false) {
    if (thinkStartRef.current > 0) {
      thinkTimeRef.current = Date.now() - thinkStartRef.current
      thinkStartRef.current = 0
    }
    const midNow = Date.now()
    if (activityRef.current.phase !== 'idle') {
      activityRef.current = completeActivity(activityRef.current, midNow)
      projectActivity(midNow)
    }
    // Freeze live tools into static log for intermediate turn
    const midTools = liveToolsRef.current
    if (midTools.length > 0) {
      pushStaticBatch(midTools)
    }
    liveToolsRef.current = []
    setLiveTools([])
    // Reset thinking state for next turn
    thinkBuf.current = ''
    setStreamingThinking('')
    setIsThinkingActive(false)
    if (thinkTimer.current) {
      clearTimeout(thinkTimer.current)
      thinkTimer.current = null
    }
    lastFlushedThink.current = ''
    return
  }

  // === 以下是 isFinal === true 的原有逻辑（不变） ===
  if (thinkStartRef.current > 0) {
```

- [ ] **步骤 5：编写多 turn 文本可见性测试**

在 `src/agent/__tests__/loop.test.ts` 添加：

```typescript
it('delivers text from all turns including after tool_use', async () => {
  const session = new SessionContext()
  const registry = new ToolRegistry()
  registry.register(READ_FILE_TOOL)

  let callCount = 0
  const client: ApiClient = {
    stream: mock.fn(async (_req: unknown, cb: StreamCallbacks) => {
      callCount++
      if (callCount === 1) {
        // Turn 1: text + tool_use
        cb.onTextDelta('Reading file...')
        cb.onContentBlock(makeTextBlock('Reading file...'))
        cb.onContentBlock(makeToolUseBlock('tu_1', 'read_file', { file_path: '/test/a.txt' }))
        cb.onStopReason('tool_use', { input_tokens: 100, output_tokens: 50 })
      } else {
        // Turn 2: text only (final)
        cb.onTextDelta('File contains hello world.')
        cb.onContentBlock(makeTextBlock('File contains hello world.'))
        cb.onStopReason('end_turn', { input_tokens: 200, output_tokens: 40 })
      }
    }),
  } as unknown as ApiClient

  const agent = new AgentLoop({
    client, promptEngine: makeEngine(), toolRegistry: registry,
    maxTurns: 5, contextWindow: 1_000_000,
    compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' },
  }, session, '/test')

  const texts: string[] = []
  let intermediateCount = 0
  let finalCount = 0

  await agent.run('read a.txt', {
    onTextDelta: (t) => texts.push(t),
    onThinkingDelta: () => {},
    onToolUse: () => {},
    onToolResult: () => {},
    onTurnComplete: (_u, _t, isFinal) => {
      if (isFinal === false) intermediateCount++
      if (isFinal === true) finalCount++
    },
    onError: (e) => { throw e },
    onAbort: () => {},
    onApprovalRequired: async () => false,
  })

  // Both turns' text should be delivered
  const allText = texts.join('')
  assert.ok(allText.includes('Reading file...'), 'Turn 1 text should be delivered')
  assert.ok(allText.includes('File contains hello world.'), 'Turn 2 text should be delivered')
  assert.equal(intermediateCount, 1, 'Should have 1 intermediate turn')
  assert.equal(finalCount, 1, 'Should have 1 final turn')
})
```

- [ ] **步骤 6：运行测试验证通过**

运行：`npx tsx --test src/agent/__tests__/loop.test.ts`
预期：全部 PASS

- [ ] **步骤 7：Commit**

```bash
git add src/agent/loop.ts src/tui/app.tsx src/agent/__tests__/loop.test.ts
git commit -m "fix(tui): distinguish intermediate/final onTurnComplete — prevents writer destruction mid-conversation"
```

---

### 任务 3：修复 B3 — Codex client 双重文本发射

**文件：**
- 修改：`src/api/codex-client.ts:296-301,340-375`
- 修改：`src/api/__tests__/codex-client.test.ts`

- [ ] **步骤 1：编写失败的测试**

在 `src/api/__tests__/codex-client.test.ts` 添加测试验证文本不被发射两次：

```typescript
it('does not double-emit text when both delta and output_item.done fire', async () => {
  // Mock SSE stream that sends BOTH delta events AND output_item.done with same text
  const sseData = [
    'data: {"type":"response.output_text.delta","delta":"Hello world"}',
    'data: {"type":"response.output_item.done","item":{"type":"message","content":[{"type":"output_text","text":"Hello world"}]}}',
    'data: {"type":"response.completed","response":{"usage":{"input_tokens":10,"output_tokens":5}}}',
  ].join('\n') + '\n'

  const mockResponse = new Response(sseData, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  })
  globalThis.fetch = async () => mockResponse

  const client = new CodexClient({ baseUrl: 'http://test', model: 'test', maxTokens: 100 })
  const textDeltas: string[] = []

  await client.stream(
    { messages: [{ role: 'user', content: 'hi' }], model: 'test', max_tokens: 100 },
    {
      onTextDelta: (t) => textDeltas.push(t),
      onThinkingDelta: () => {},
      onContentBlock: () => {},
      onStopReason: () => {},
    },
  )

  // Text should appear exactly ONCE, not twice
  const total = textDeltas.join('')
  assert.equal(total, 'Hello world', 'Text should not be doubled')
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npx tsx --test src/api/__tests__/codex-client.test.ts`
预期：FAIL — `total` 等于 "Hello worldHello world"（双重发射）

- [ ] **步骤 3：实现修复**

在 `src/api/codex-client.ts` 的 `processSSEStream` 方法中，在 `let seenReasoningItem = false` 附近添加：

```typescript
let seenTextDelta = false
```

修改 `response.output_text.delta` handler（约 line 296-302）：

```typescript
case 'response.output_text.delta': {
  seenTextDelta = true  // ← 添加这一行
  const text = typeof parsed.delta === 'string'
    ? parsed.delta
    : (parsed.delta as Record<string, unknown>)?.text as string | undefined
  if (text) callbacks.onTextDelta(text)
  break
}
```

修改 `output_item.done` message handler（约 line 340-375），在文本发射前添加 `seenTextDelta` 守卫。将整个 `} else if (item?.type === 'message') {` 分支改为：

```typescript
} else if (item?.type === 'message') {
  const content = item.content as Array<Record<string, unknown>> | undefined
  const msgUsage = item.usage as Record<string, unknown> | undefined

  if (seenTextDelta) {
    // Deltas already delivered text — only extract usage + content blocks
    if (content) {
      for (const part of content) {
        if (part.type === 'output_text' && typeof part.text === 'string') {
          callbacks.onContentBlock({ type: 'text', text: part.text })
        }
      }
    }
    if (msgUsage) {
      usage = {
        input_tokens: msgUsage.input_tokens as number,
        output_tokens: msgUsage.output_tokens as number,
      }
    }
  } else if (!seenReasoningItem) {
    // No deltas seen, buffer for reasoning ordering
    const texts: string[] = []
    const blocks: ContentBlock[] = []
    if (content) {
      for (const part of content) {
        if (part.type === 'output_text' && typeof part.text === 'string') {
          texts.push(part.text)
          blocks.push({ type: 'text', text: part.text })
        }
      }
    }
    pendingMessageItem = { texts, blocks, msgUsage }
  } else {
    // No deltas, reasoning already seen — emit immediately
    if (content) {
      for (const part of content) {
        if (part.type === 'output_text' && typeof part.text === 'string') {
          callbacks.onTextDelta(part.text)
          callbacks.onContentBlock({ type: 'text', text: part.text })
        }
      }
    }
    if (msgUsage) {
      usage = {
        input_tokens: msgUsage.input_tokens as number,
        output_tokens: msgUsage.output_tokens as number,
      }
    }
  }
}
```

同时修改 `flushPendingMessage`，添加 seenTextDelta 守卫：

```typescript
const flushPendingMessage = () => {
  if (!pendingMessageItem) return
  if (!seenTextDelta) {
    for (const t of pendingMessageItem.texts) {
      callbacks.onTextDelta(t)
    }
  }
  for (const b of pendingMessageItem.blocks) {
    callbacks.onContentBlock(b)
  }
  if (pendingMessageItem.msgUsage) {
    usage = {
      input_tokens: pendingMessageItem.msgUsage.input_tokens as number,
      output_tokens: pendingMessageItem.msgUsage.output_tokens as number,
    }
  }
  pendingMessageItem = null
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`npx tsx --test src/api/__tests__/codex-client.test.ts`
预期：全部 PASS

- [ ] **步骤 5：验证无回归 — 纯 output_item.done 场景**

确认现有测试中"no delta, only output_item.done"的场景仍然 PASS（`seenTextDelta` 为 false 时走原有路径）。

- [ ] **步骤 6：Commit**

```bash
git add src/api/codex-client.ts src/api/__tests__/codex-client.test.ts
git commit -m "fix(codex): prevent double text emission when both delta and output_item.done fire"
```

---

### 任务 4：修复 B4 — StreamOutput wrap 截断

**文件：**
- 修改：`src/tui/stream.tsx:17`

- [ ] **步骤 1：修改 StreamOutput 组件**

在 `src/tui/stream.tsx`，修改 line 17：

```typescript
// 修改前：
<Text wrap="wrap">{text}</Text>

// 修改后：
<Text>{text}</Text>
```

Ink 6.x 的 `<Text>` 不指定 wrap 时默认行为已经是换行。显式设置 `wrap="wrap"` 会触发 ink#245 的 yoga layout 计算 bug 导致最后一行截断。去掉属性即可规避。

如果去掉后长行不换行（需实测），替代方案：

```tsx
<Box width="100%">
  <Text>{text}</Text>
</Box>
```

- [ ] **步骤 2：手动验证**

启动 TUI，发送会产生长行输出的请求，确认：
- 文本正常换行
- 最后一行不被截断
- 无视觉回归

- [ ] **步骤 3：Commit**

```bash
git add src/tui/stream.tsx
git commit -m "fix(tui): remove explicit wrap='wrap' — avoids Ink last-line truncation (ink#245)"
```

---

### 任务 5：集成验证

- [ ] **步骤 1：运行完整测试套件**

```bash
npx tsx --test src/agent/__tests__/loop.test.ts src/api/__tests__/codex-client.test.ts src/tui/__tests__/block-stream-writer.test.ts src/tui/__tests__/stream-window.test.ts
```

预期：全部 PASS

- [ ] **步骤 2：TypeScript 类型检查**

```bash
npx tsc --noEmit
```

预期：无错误。`onTurnComplete` 的 `isFinal` 参数是 optional (`isFinal?: boolean`)，现有调用点无需修改。

- [ ] **步骤 3：手动端到端测试**

启动 Rivet TUI，执行以下场景：

| 场景 | 操作 | 验证 |
|------|------|------|
| A (B1) | 发送触发工具调用的请求 | 工具前后的文本都可见 |
| B (B2) | 连续发送两次相同问题 | 两次回复都可见 |
| C (B3) | Codex 模式发送请求 | 回复不重复 |
| D (B4) | 发送产生长段落的请求 | 最后一行完整可见 |

- [ ] **步骤 4：最终 Commit**

```bash
git commit --allow-empty -m "verify: text-swallowing fixes — all 4 bugs resolved, manual E2E passed"
```

---

## 自检结果

**规格覆盖度：** 4 个 bug 各有对应任务（B1→任务2, B2→任务1, B3→任务3, B4→任务4）。集成验证覆盖所有场景。

**占位符扫描：** 无"待定"、"TODO"。B4 的替代方案已内联说明。

**类型一致性：** `isFinal?: boolean` 在 loop.ts 类型定义（任务2步骤1）、调用点（步骤2-3）、和 app.tsx handler（步骤4）中保持一致。Optional parameter 确保向后兼容。

---

## 执行优先级

| 顺序 | 任务 | 修复 | 风险 | 预计时间 |
|------|------|------|------|----------|
| 1 | 任务 1 | B2 lastTurnText 重置 | 极低（1 行改动） | 5 min |
| 2 | 任务 2 | B1 onTurnComplete isFinal | 中（核心修复，需仔细测试） | 20 min |
| 3 | 任务 3 | B3 Codex 双重发射 | 低（独立模块） | 15 min |
| 4 | 任务 4 | B4 wrap 截断 | 极低（1 行改动，需手动验证） | 5 min |
| 5 | 任务 5 | 集成验证 | — | 10 min |

**总预计时间：** ~55 分钟

**关键依赖：** 任务 2 依赖任务 1（lastTurnText 重置后去重逻辑才正确）。任务 3、4 互相独立。
