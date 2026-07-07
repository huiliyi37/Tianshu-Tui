# TUI 内容重复与截断问题分析

> 2026-06-01 · 问题诊断与修复计划

## 问题现象

用户反馈：整个终端里全是回复内容的重复，只能看到一部分内容。

## 问题分类

### P1: StreamOutput 与 Static 同时可见（重叠帧）

**位置**: `src/tui/app.tsx:1139-1140`

**现象**: turn 结束时，StreamOutput 的尾部文本和 AssistantMessage 的完整文本同时显示在屏幕上。

**根因**: turn-end 逻辑的执行顺序：
```typescript
// 当前顺序（有问题）
pushAssistantEntry(finalText, thinkingForArchive)  // 1. 推入 Static
setIsStreaming(false)                                // 2. 关闭 StreamOutput
setStreamingText('')                                 // 3. 清空文本
```

在步骤 1 和步骤 2 之间有一帧重叠，React 同时渲染 StreamOutput 和新的 AssistantMessage。

**修复方案**: 调整顺序，先卸载 StreamOutput 再推入 Static：
```typescript
// 修复后顺序
setIsStreaming(false)                                // 1. 先关闭 StreamOutput
setStreamingText('')                                 // 2. 清空文本
pushAssistantEntry(finalText, thinkingForArchive)    // 3. 再推入 Static
```

**影响范围**: `onTurnComplete` 的 final turn 处理分支。

---

### P2: 中间 turn 不清理流式文本（跨 turn 累积）

**位置**: `src/tui/app.tsx` 的 `onTurnComplete` 中间 turn 处理（`isFinal === false`）

**现象**: 多 turn 运行时，StreamOutput 显示所有 turn 的累积文本，越来越长。

**根因**: 中间 turn 结束时的处理逻辑：
```typescript
if (isFinal === false) {
  textBatcher.current.flushNow()
  // ... 冻结 tools 到 Static
  // ... 重置 thinking
  return  // ❌ 不清理 streamBuf，不清理 streamingText
}
```

`streamBuf.current` 和 `streamLiveBuf.current` 跨 turn 累积，导致 StreamOutput 显示所有历史文本。

**修复方案**: 中间 turn 结束时，将当前文本推入 Static 并清空缓冲区：
```typescript
if (isFinal === false) {
  textBatcher.current.flushNow()
  
  // 新增：推送当前 turn 的文本到 Static
  const midText = streamBuf.current
  if (midText) {
    pushAssistantEntry(midText, thinkBuf.current || undefined)
  }
  
  // 新增：清空流式缓冲区
  streamBuf.current = ''
  streamLiveBuf.current = ''
  setStreamingText('')
  
  // ... 原有逻辑：冻结 tools，重置 thinking
  return
}
```

**影响范围**: `onTurnComplete` 的 intermediate turn 处理分支。

---

### P3: 模型行为冗余（重复读取同一文件）

**位置**: 模型侧（prompt 或 agent loop）

**现象**: 同一个 agent run 中，模型多次调用 `read_file` 读取相同文件，产生重复的 ToolCard。

**证据**: 用户截图中的 raw hash：
- `read_file(architecture-overview.md)` → `524e32d6...` 和 `c9b9570b...`（两次读取）
- `repo_map(depth=2)` → 两次调用，内容大量重叠

**根因**: 模型在规划工具调用时没有检查已读取的文件列表，导致冗余调用。

**修复方案**（3 选 1）:

**方案 A: Prompt 层约束**
在 `src/prompt/volatile.ts` 中添加已读取文件列表，并在 prompt 中明确指示：
```
已读取文件：architecture-overview.md, package.json, ...
不要重复读取已读取的文件，除非需要刷新内容。
```

**方案 B: 工具层去重**
在 `src/tools/read-file.ts` 中添加缓存，相同路径 + 相同版本的文件只读取一次：
```typescript
const fileCache = new Map<string, { content: string, hash: string }>()
// 如果缓存命中且文件未修改，直接返回缓存内容
```

**方案 C: Agent loop 层拦截**
在 `src/agent/loop.ts` 的工具调用前检查，如果最近 N 个 turn 内已读取相同文件，跳过调用并返回缓存结果。

**推荐**: 方案 A（成本最低，效果最直接）。

---

### P4: AssistantMessage 截断（MAX_STATIC_LINES = 80）

**位置**: `src/tui/assistant-message.tsx:23`

**现象**: 长回复（>80 行）被截断，前 52 行（包括架构图、核心设计表）被砍掉，只显示尾部。

**根因**:
```typescript
const MAX_STATIC_LINES = 80
const maxLines = useViewportLines(0.6, 20, MAX_STATIC_LINES)
// ...
const displayContent = isLong ? lines.slice(-maxLines).join('\n') : content
```

这个限制是为了防止长回复阻塞 Node 事件循环（注释中有说明），但副作用是用户看不到完整内容。

**修复方案**（3 选 1）:

**方案 A: 提高限制 + 懒渲染**
将 `MAX_STATIC_LINES` 提高到 200，并使用 React.lazy 或 IntersectionObserver 实现懒加载：
```typescript
const MAX_STATIC_LINES = 200
// 初始只显示前 80 行，滚动到底部时加载更多
```

**方案 B: 全文持久化 + 截断显示**
将完整内容写入 artifact 存储，AssistantMessage 显示截断版本 + "查看全文" 链接：
```typescript
const fullPath = await artifactStore.save(content)
// 显示截断版本 + "View full: /path/to/artifact"
```

**方案 C: 分段归档**
将长回复拆分为多个 AssistantMessage（每段 80 行），避免单条消息过长：
```typescript
const chunks = chunkLines(content, 80)
for (const chunk of chunks) {
  pushAssistantEntry(chunk)
}
```

**推荐**: 方案 B（保留完整内容，不阻塞事件循环，用户可选择查看）。

---

### P5: ToolCard 工具结果冗长（大文件占满屏幕）

**位置**: `src/tui/app.tsx` 的 `onToolResult` 处理

**现象**: `read_file` 返回的大文件（如 architecture-overview.md 185 行）占满整个屏幕，挤压其他内容。

**根因**: 工具结果直接推入 Static，没有智能折叠：
```typescript
pushStatic(createLogEntry({ type: 'tool', id, toolName, content: finalContent, isError, rawPath }))
```

虽然 `summarizeToolOutput` 会折叠超长内容，但阈值较高（verbose=false 时 8 行），大文件仍然显示很多行。

**修复方案**:

**方案 A: 智能折叠**
根据文件类型和长度动态调整折叠策略：
```typescript
const maxLines = toolName === 'read_file' && result.length > 1000 ? 20 : 8
const content = summarizeToolOutput(finalContent, maxLines)
```

**方案 B: 默认折叠 + 展开交互**
ToolCard 默认只显示前 5 行 + "展开" 按钮，用户按 Enter 展开查看完整内容。

**方案 C: Artifact 链接**
大文件结果写入 artifact，ToolCard 只显示 "Saved to artifact: /path/to/file"。

**推荐**: 方案 A（成本最低，效果明显）。

---

## 修复优先级

| 优先级 | 问题 | 修复难度 | 影响范围 |
|--------|------|---------|---------|
| P1 | StreamOutput/Static 重叠帧 | 低 | `app.tsx` 1 处 |
| P2 | 中间 turn 不清理流式文本 | 中 | `app.tsx` 1 处 |
| P3 | 模型重复读取文件 | 中 | `prompt/volatile.ts` 或 `tools/read-file.ts` |
| P4 | AssistantMessage 截断 | 中 | `assistant-message.tsx` + artifact 集成 |
| P5 | ToolCard 结果冗长 | 低 | `app.tsx` 1 处 |

## 修复顺序建议

1. **P1**（最简单，立竿见影）
2. **P5**（简单，改善视觉体验）
3. **P2**（中等，解决跨 turn 累积）
4. **P3**（中等，减少冗余调用）
5. **P4**（中等，需要 artifact 集成）

## 验证方法

每个修复后运行：
```bash
npx tsc --noEmit
npm exec -- tsx --test src/tui/__tests__/*.test.ts
```

手动验证：
1. 启动 `node dist/main.js`
2. 输入 "你好 了解一下整个项目和架构"
3. 观察：
   - StreamOutput 是否在 turn 结束时立即消失（P1）
   - 多 turn 运行时 StreamOutput 是否只显示当前 turn 的文本（P2）
   - 是否还有重复的 ToolCard（P3）
   - 长回复是否能看到完整内容（P4）
   - ToolCard 是否更紧凑（P5）
