# Session Rendering P1/P2: AssistantMessage + Segmented Static

> **Wave 13.5 · Visual Hierarchy + Performance**
> 衔接 P0（消息类型分离 + 工具折叠），完成会话渲染的视觉层次和性能优化

---

## 1. 目标

1. **P1**：助手消息获得独立视觉标识（`●` 品牌色前缀 + `⎿` 缩进），与用户消息 `❯` 和工具卡片 `▷` 形成清晰的视觉层级
2. **P2**：Static 分段（frozen + active），减少每帧 diff 范围，解决长会话的渲染退化

## 2. 外部调研关键发现

### 2.1 Claude Code 的 Static 去除教训

Claude Code (40k+ stars) 移除了 `<Static>` 改用双缓冲 + blit diff + TypedArray 屏幕缓冲。结果：
- 频繁全组件树重渲染导致 GC 暂停
- 帧预算 ~16ms，React 场景图到 ANSI 仅 ~5ms
- Issue #31194: 会话越长、CPU 负载越高，退化越严重

**结论**：保留 Ink Static，优化其分段策略比完全去除更稳健。

### 2.2 Codex CLI 的 stageItem 模式

OpenAI Codex CLI 使用 `stageItem()` 分阶段调度显示，与 frozen/active 分段天然契合：
- 已完成的消息进入历史区（不再变化）
- 活跃区只包含正在流式输出的内容

### 2.3 Ink Static 性能特性

- Static 内部通过 diff items 数组，只渲染新增项
- 每次 push 创建新数组拷贝，500 项时 O(n) 开销
- JSX 过度分配会导致 GC 暂停 — 历史组件需要 React.memo
- 退格键在多步渲染管线中延迟感知比流式输出更严重

## 3. 设计决策

### D1: AssistantMessage 独立组件（非修改 StreamOutput）

**选择**：新建 `AssistantMessage` 组件
**理由**：
- StreamOutput 同时服务流式和静态渲染，加前缀会导致流式时 `●` 闪烁
- 职责分离：StreamOutput 负责流式文本，AssistantMessage 负责静态助手消息
- 组件极简（< 40 行），不增加维护负担

### D2: 缩进使用 `⎿` + dimColor

**选择**：续行用 `⎿` 2 字符缩进，dimColor
**理由**：
- Claude Code 的 MessageResponse 使用同一模式，经过大规模验证
- 不增加视觉噪音，仅做层级提示
- 2 字符宽度与 `● ` 前缀对齐

### D3: 流式区不加前缀

**选择**：streaming 区保持 `<StreamOutput>` 不变
**理由**：
- 流式文本是增量追加的，加前缀会在每次 append 时重复
- turn 结束后整体固化时才加上 `●` 前缀，视觉上自然过渡

### D4: Frozen + Active 双 Static

**选择**：两个独立的 `<Static>` 实例
**理由**：
- Ink 的 Static 组件内部通过数组 diff 判断新增项
- 冻结区一旦渲染，不再变化，diff 永远返回 0 新增
- 活跃区只有最近 N 条，diff 范围固定为 O(N) 而非 O(total)
- 阈值 20 条：经验上 20 条消息的 diff 在 5ms 内完成

### D5: 迁移时机

**选择**：每次 turn 结束时检查并迁移
**理由**：
- turn 结束是自然的逻辑断点
- 避免在 streaming 中间做迁移导致视觉跳跃
- 迁移操作：将 activeItems 中超过阈值的部分追加到 frozenBuf

### D6: 不做的事（YAGNI）

- **不引入** ink-ui ThemeProvider（已有 theme.ts 足够）
- **不做**虚拟滚动（终端原生管理 scrollback，Ink 无法控制）
- **不做** TypedArray 双缓冲（P2 的分段优化已足够，这是 Claude Code 的 Phase 2+ 优化）
- **不做**时间戳/turn 编号显示（后续迭代，当前聚焦视觉层次）

## 4. 组件设计

### 4.1 AssistantMessage

```typescript
// src/tui/assistant-message.tsx

interface AssistantMessageProps {
  content: string
}

// 渲染：
// ● 第一行文本内容（lavender 色 ●）
// ⎿ 续行文本（dimColor ⎿ + 正常文本）
// 单行时只有 ● 行
```

视觉示例：
```
 ● 这是助手的第一行回复内容，包含一些文字
 ⎿ 这是第二行，继续缩进对齐
 ⎿ 第三行也是
```

颜色：
- `●` 使用 `theme.assistantColor`（lavender #d4a5f5）
- `⎿` 使用 `theme.dim`（#8585a0）
- 文本使用默认前景色

### 4.2 renderStaticEntry 变更

```typescript
case 'assistant_message':
  return <AssistantMessage key={entry.id} content={entry.content} />
```

流式区不变：
```typescript
{(streamingText || isStreaming) && (
  <StreamOutput text={streamingText} isStreaming={isStreaming} />
)}
```

## 5. 分段 Static 设计

### 5.1 数据结构

```typescript
const staticBuf = useMemo(() => createRingBuffer<LogEntry>(500), [])
const frozenBuf = useMemo(() => createRingBuffer<LogEntry>(500), [])
const [frozenItems, setFrozenItems] = useState<LogEntry[]>([])
const [activeItems, setActiveItems] = useState<LogEntry[]>([])

const ACTIVE_THRESHOLD = 20
```

### 5.2 pushStatic 变更

```typescript
const pushStatic = useCallback((entry: LogEntry) => {
  staticBuf.push(entry)
  setActiveItems(staticBuf.items())
}, [staticBuf])
```

### 5.3 迁移逻辑（turn 结束时）

```typescript
const migrateToFrozen = useCallback(() => {
  const active = staticBuf.items()
  if (active.length <= ACTIVE_THRESHOLD) return
  const migrateCount = active.length - ACTIVE_THRESHOLD
  const toFreeze = active.slice(0, migrateCount)
  for (const item of toFreeze) frozenBuf.push(item)
  staticBuf.clear()
  for (const item of active.slice(migrateCount)) staticBuf.push(item)
  setFrozenItems(frozenBuf.items())
  setActiveItems(staticBuf.items())
}, [staticBuf, frozenBuf])
```

### 5.4 渲染结构

```typescript
<>
  <Static items={frozenItems}>
    {(item) => renderStaticEntry(item, verbose)}
  </Static>
  <Static items={useMemo(() => groupLogs(activeItems), [activeItems])}>
    {(item) => renderStaticEntry(item, verbose)}
  </Static>
  <Box flexDirection="column">
    {/* ... 活跃区：streaming, liveTools, input ... */}
  </Box>
</>
```

### 5.5 history-replay 适配

session 恢复时，所有条目直接推入 frozenBuf（历史不需要活跃区）：
```typescript
const { entries } = replayMessagesToLogEntries(msgs)
for (const entry of entries) frozenBuf.push(entry)
setFrozenItems(frozenBuf.items())
```

## 6. 文件变更清单

### 新建

| 文件 | 职责 |
|------|------|
| `src/tui/assistant-message.tsx` | 助手消息渲染组件（`●` 前缀 + `⎿` 缩进） |
| `src/tui/__tests__/assistant-message.test.ts` | 组件测试 |

### 修改

| 文件 | 变更 |
|------|------|
| `src/tui/app.tsx` | renderStaticEntry 用 AssistantMessage + 双 Static 分段 + frozenBuf 迁移 |
| `src/tui/ring-buffer.ts` | 新增 `clear()` 方法（迁移时需要） |
| `src/tui/__tests__/ring-buffer.test.ts` | clear 方法测试 |

## 7. 性能预期

| 指标 | P0 现状 | P2 改进后 |
|------|---------|----------|
| 每次 push diff 范围 | O(total) ~500 条 | O(active) ~20 条 |
| frozen 区 diff | 每次都扫描全量 | 迁移时才变化，平时 diff=0 |
| turn 结束迁移 | 无 | 一次性 O(migrateCount) |
| 内存 | 1 个 RingBuffer(500) | 2 个 RingBuffer(500+500) |

## 8. 风险评估

| 风险 | 缓解 |
|------|------|
| 双 Static 导致渲染顺序问题 | Ink Static 按顺序渲染，frozen 在前 active 在后，顺序保证 |
| 迁移时闪烁 | 迁移在 turn 结束后执行，此时没有流式输出，用户感知为零 |
| RingBuffer.clear() 破坏引用 | 新增 clear 方法只重置内部索引，不改变缓冲区大小 |
| frozenBuf 无上限增长 | RingBuffer 已有容量上限（500），超出自动淘汰旧条目 |
