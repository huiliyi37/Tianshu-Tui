# TUI 内容丢失修复 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 修复 TUI 中 3 个内容丢失漏洞——思考内容流式结束后消失、onError/onAbort 丢失已流式文本、历史回放跳过 thinking 块。

**架构：** 在 `app.tsx` 的 `onTurnComplete`/`onError`/`onAbort` 回调中保存思考和部分文本到日志历史；在 `history-replay.ts` 中增加 thinking 块处理；在 `log-state.ts` 中增加 `thinking` 字段。

**技术栈：** TypeScript, React (Ink), 现有 LogEntry / history-replay 基础设施。

**前置条件：** 无外部依赖，可独立执行。

---

## 文件结构

| 文件 | 操作 | 职责 |
|------|------|------|
| `src/tui/log-state.ts` | 修改 | LogEntry 增加可选 `thinking` 字段 |
| `src/tui/app.tsx` | 修改 | onTurnComplete/onError/onAbort 保存思考和部分文本 |
| `src/tui/history-replay.ts` | 修改 | 回放时处理 thinking 块 |
| `src/tui/__tests__/history-replay.test.ts` | 修改 | 新增 thinking 回放测试 |
| `src/tui/__tests__/content-preservation.test.ts` | 创建 | onError/onAbort 内容保存测试 |

---

### 任务 1：LogEntry 增加 thinking 字段

**文件：**
- 修改：`src/tui/log-state.ts:10-19`

- [ ] **步骤 1：修改 LogEntry interface**

在 `src/tui/log-state.ts` 的 `LogEntry` interface 中添加 `thinking` 字段：

```typescript
export interface LogEntry {
  type: LogEntryType
  id: string
  content: string
  toolName?: string
  isError?: boolean
  rawPath?: string
  turnNumber?: number
  children?: LogEntry[]
  thinking?: string   // ← 新增：保存 assistant 思考内容
}
```

同步更新 `createLogEntry` 的参数类型（第 25-36 行），在入参 interface 中加 `thinking?: string`：

```typescript
export function createLogEntry(entry: {
  id?: string
  type: LogEntryType
  content: string
  toolName?: string
  isError?: boolean
  rawPath?: string
  turnNumber?: number
  children?: LogEntry[]
  thinking?: string
}): LogEntry {
  return { ...entry, id: entry.id ?? `l${_nextLogId++}` }
}
```

- [ ] **步骤 2：运行 typecheck**

运行：`npx tsc --noEmit 2>&1 | tail -5`
预期：无错误（新字段是可选的，不破坏现有代码）

- [ ] **步骤 3：Commit**

```bash
git add src/tui/log-state.ts
git commit -m "feat(tui): add thinking field to LogEntry for content preservation"
```

---

### 任务 2：onTurnComplete 保存思考内容

**文件：**
- 修改：`src/tui/app.tsx:589-614`

- [ ] **步骤 1：修改 onTurnComplete 将 thinking 存入日志**

在 `src/tui/app.tsx` 的 `onTurnComplete` 回调中，修改 assistant_message 推入逻辑，将 `thinkBuf.current` 附加到 LogEntry：

找到（约第 602 行）：
```typescript
            pushStatic(createLogEntry({ type: 'assistant_message', content: finalText }))
```

替换为：
```typescript
            pushStatic(createLogEntry({ type: 'assistant_message', content: finalText, thinking: thinkBuf.current || undefined }))
```

同样修改 interview marker 分支（约第 599 行）：
```typescript
              pushStatic(createLogEntry({ type: 'assistant_message', content: parsed.cleanText, thinking: thinkBuf.current || undefined }))
```

- [ ] **步骤 2：处理"只有思考没有文本"的边界情况**

在 `const finalText = streamBuf.current` 之后（约第 589 行），如果 `finalText` 为空但 `thinkBuf.current` 不为空，仍然应该推入日志。修改条件判断：

找到：
```typescript
        const finalText = streamBuf.current
        if (finalText) {
```

替换为：
```typescript
        const finalText = streamBuf.current
        if (finalText || thinkBuf.current) {
```

并且在 `if (finalText)` 内部的 `pushStatic` 之前加一个内部检查，避免推入空 content：

```typescript
        const finalText = streamBuf.current
        if (finalText || thinkBuf.current) {
          if (finalText) {
            const parsed = parseInterviewMarker(finalText)
            if (parsed) {
              setInterviewState(parsed.state)
              setClarityHistory(prev => [...prev, parsed.state.clarity])
              if (parsed.state.confirmed) {
                setSummaryState(prev => ({ ...prev, phase: 'interview' }))
              }
              if (parsed.cleanText) {
                pushStatic(createLogEntry({ type: 'assistant_message', content: parsed.cleanText, thinking: thinkBuf.current || undefined }))
              }
            } else {
              pushStatic(createLogEntry({ type: 'assistant_message', content: finalText, thinking: thinkBuf.current || undefined }))
            }
          } else {
            // Only thinking, no visible text — still preserve for history
            pushStatic(createLogEntry({ type: 'assistant_message', content: '', thinking: thinkBuf.current }))
          }
        }
```

- [ ] **步骤 3：运行 typecheck**

运行：`npx tsc --noEmit 2>&1 | tail -5`
预期：无错误

- [ ] **步骤 4：Commit**

```bash
git add src/tui/app.tsx
git commit -m "fix(tui): preserve thinking content in log history on turn complete"
```

---

### 任务 3：onError/onAbort 保存已流式文本

**文件：**
- 修改：`src/tui/app.tsx:657-685`

- [ ] **步骤 1：修改 onError 保存部分文本**

找到 `onError` 回调（约第 657 行）：

```typescript
      onError: (error) => {
        if (thinkTimer.current) { clearTimeout(thinkTimer.current); thinkTimer.current = null }
        if (toolTimer.current) { clearTimeout(toolTimer.current); toolTimer.current = null }
        blockWriterRef.current?.flush()
        blockWriterRef.current = null
        streamBuf.current = ''
        setStreamingText('')
        thinkBuf.current = ''
        setStreamingThinking('')
```

替换为：

```typescript
      onError: (error) => {
        if (thinkTimer.current) { clearTimeout(thinkTimer.current); thinkTimer.current = null }
        if (toolTimer.current) { clearTimeout(toolTimer.current); toolTimer.current = null }
        blockWriterRef.current?.flush()
        blockWriterRef.current = null
        // Preserve any partial text/thinking before clearing
        if (streamBuf.current || thinkBuf.current) {
          pushStatic(createLogEntry({ type: 'assistant_message', content: streamBuf.current, thinking: thinkBuf.current || undefined }))
        }
        streamBuf.current = ''
        setStreamingText('')
        thinkBuf.current = ''
        setStreamingThinking('')
```

- [ ] **步骤 2：修改 onAbort 保存部分文本**

找到 `onAbort` 回调（约第 672 行）：

```typescript
      onAbort: () => {
        if (thinkTimer.current) { clearTimeout(thinkTimer.current); thinkTimer.current = null }
        if (toolTimer.current) { clearTimeout(toolTimer.current); toolTimer.current = null }
        blockWriterRef.current?.flush()
        blockWriterRef.current = null
        streamBuf.current = ''
        setStreamingText('')
        thinkBuf.current = ''
        setStreamingThinking('')
```

替换为：

```typescript
      onAbort: () => {
        if (thinkTimer.current) { clearTimeout(thinkTimer.current); thinkTimer.current = null }
        if (toolTimer.current) { clearTimeout(toolTimer.current); toolTimer.current = null }
        blockWriterRef.current?.flush()
        blockWriterRef.current = null
        // Preserve any partial text/thinking before clearing
        if (streamBuf.current || thinkBuf.current) {
          pushStatic(createLogEntry({ type: 'assistant_message', content: streamBuf.current, thinking: thinkBuf.current || undefined }))
        }
        streamBuf.current = ''
        setStreamingText('')
        thinkBuf.current = ''
        setStreamingThinking('')
```

- [ ] **步骤 3：运行 typecheck**

运行：`npx tsc --noEmit 2>&1 | tail -5`
预期：无错误

- [ ] **步骤 4：Commit**

```bash
git add src/tui/app.tsx
git commit -m "fix(tui): preserve partial text and thinking on error/abort"
```

---

### 任务 4：历史回放支持 thinking 块

**文件：**
- 修改：`src/tui/history-replay.ts:33-39`
- 修改：`src/tui/__tests__/history-replay.test.ts`

- [ ] **步骤 1：编写失败的测试**

在 `src/tui/__tests__/history-replay.test.ts` 中追加：

```typescript
it('preserves thinking blocks in assistant messages', () => {
  const messages: Message[] = [
    { role: 'user', content: 'hello' },
    {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'Let me think about this...' },
        { type: 'text', text: 'Here is my answer.' },
      ],
    },
  ]
  const { entries } = replayMessagesToLogEntries(messages)
  const assistantEntry = entries.find(e => e.type === 'assistant_message')!
  assert.strictEqual(assistantEntry.content, 'Here is my answer.')
  assert.strictEqual(assistantEntry.thinking, 'Let me think about this...')
})

it('handles thinking-only messages without text', () => {
  const messages: Message[] = [
    { role: 'user', content: 'hello' },
    {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'Analyzing...' },
      ],
    },
  ]
  const { entries } = replayMessagesToLogEntries(messages)
  const assistantEntry = entries.find(e => e.type === 'assistant_message')
  assert.ok(assistantEntry, 'should create entry for thinking-only message')
  assert.strictEqual(assistantEntry!.thinking, 'Analyzing...')
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npm test -- --test-name-pattern "preserves thinking|thinking-only" 2>&1 | tail -10`
预期：FAIL（当前 thinking 块被跳过）

- [ ] **步骤 3：修改 history-replay.ts**

替换 `src/tui/history-replay.ts` 第 33-39 行的 assistant 处理逻辑：

```typescript
    if (msg.role === 'assistant' && Array.isArray(msg.content)) {
      let text = ''
      let thinking = ''
      for (const block of msg.content as ContentBlock[]) {
        if (block.type === 'text') {
          text += (text ? '\n' : '') + block.text
        } else if (block.type === 'thinking') {
          thinking += (thinking ? '\n' : '') + (block as { type: 'thinking'; thinking: string }).thinking
        }
      }
      if (text || thinking) {
        entries.push(createLogEntry({
          type: 'assistant_message',
          content: text,
          thinking: thinking || undefined,
          turnNumber: turnCount,
        }))
      }
      continue
    }
```

- [ ] **步骤 4：运行测试验证通过**

运行：`npx tsc --noEmit && npm test -- --test-name-pattern "preserves thinking|thinking-only|replayMessages" 2>&1 | tail -10`
预期：全部 PASS

- [ ] **步骤 5：Commit**

```bash
git add src/tui/history-replay.ts src/tui/__tests__/history-replay.test.ts
git commit -m "fix(tui): replay thinking blocks in session history"
```

---

### 任务 5：全量验证

- [ ] **步骤 1：运行 typecheck + 全量测试**

运行：`npx tsc --noEmit && npm test 2>&1 | grep -E "^ℹ (tests|pass|fail)"`
预期：0 errors, 1050+ pass, 0 fail

- [ ] **步骤 2：手动验证（可选）**

启动 Rivet，发送一条需要思考的请求，观察：
1. 流式过程中思考内容可见
2. 回复结束后思考内容仍存在于历史中
3. Ctrl+C 中断后，已输出的部分文本保留在历史中
4. session 恢复后思考内容可见

- [ ] **步骤 3：最终 Commit**

如果有额外修复：
```bash
git add -u
git commit -m "fix(tui): content preservation — final adjustments"
```

---

## 自检

1. **覆盖度：** 3 个漏洞全部覆盖（thinking 保存 ✓、onError/onAbort 保存 ✓、历史回放 ✓）
2. **占位符扫描：** 无 TODO/TBD，所有步骤有完整代码
3. **类型一致性：** `thinking` 字段在 LogEntry（Task 1）定义，在 app.tsx（Task 2/3）写入，在 history-replay（Task 4）读取

---

## 风险

| 风险 | 防线 |
|------|------|
| thinking 字段增加 LogEntry 内存 | thinking 是可选字段，仅在有内容时赋值；RingBuffer 500 条上限不变 |
| onError 推入空 content LogEntry | 条件判断 `if (streamBuf.current \|\| thinkBuf.current)` 防止空推入 |
| 回放时 thinking 块类型不在 ContentBlock union 中 | 用 `as` 断言处理，因为 API 层已经在返回 thinking 块 |
