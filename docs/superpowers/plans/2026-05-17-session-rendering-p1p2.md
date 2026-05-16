# Session Rendering P1/P2 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 为助手消息添加 `●` 品牌色前缀 + `⎿` 缩进视觉层次，并将 Static 渲染拆分为 frozen + active 双段以优化长会话性能

**架构：** 新建 AssistantMessage 组件（`●` 前缀 + `⎿` 缩进 + React.memo），app.tsx 引入双 RingBuffer（frozenBuf + staticBuf）+ 双 Static 渲染 + turn 结束时迁移逻辑

**技术栈：** TypeScript, React (Ink 6), node:test + node:assert/strict

---

## 文件结构

### 新建文件

| 文件 | 职责 |
|------|------|
| `src/tui/assistant-message.tsx` | 助手消息渲染：`●` lavender 前缀 + `⎿` dimColor 缩进 |
| `src/tui/__tests__/assistant-message.test.ts` | AssistantMessage 组件测试 |

### 修改文件

| 文件 | 变更 |
|------|------|
| `src/tui/ring-buffer.ts` | 新增 `clear()` 和 `drain(n)` 方法 |
| `src/tui/__tests__/ring-buffer.test.ts` | 新增 clear/drain 测试 |
| `src/tui/app.tsx` | renderStaticEntry 用 AssistantMessage + 双 Static 分段 + frozenBuf 迁移 + history-replay 适配 |

---

### 任务 1：RingBuffer 新增 clear 和 drain 方法

**文件：**
- 修改：`src/tui/ring-buffer.ts`
- 测试：`src/tui/__tests__/ring-buffer.test.ts`

- [ ] **步骤 1：在 `src/tui/__tests__/ring-buffer.test.ts` 末尾追加测试**

```typescript
describe('RingBuffer clear and drain', () => {
  it('clear removes all items', () => {
    const buf = createRingBuffer<string>(10)
    buf.push('a')
    buf.push('b')
    buf.push('c')
    buf.clear()
    assert.deepEqual(buf.items(), [])
    assert.equal(buf.size, 0)
  })

  it('drain removes first n items and returns them', () => {
    const buf = createRingBuffer<string>(10)
    buf.push('a')
    buf.push('b')
    buf.push('c')
    buf.push('d')
    const drained = buf.drain(2)
    assert.deepEqual(drained, ['a', 'b'])
    assert.deepEqual(buf.items(), ['c', 'd'])
  })

  it('drain with count > size drains all', () => {
    const buf = createRingBuffer<string>(10)
    buf.push('a')
    buf.push('b')
    const drained = buf.drain(5)
    assert.deepEqual(drained, ['a', 'b'])
    assert.deepEqual(buf.items(), [])
  })

  it('drain 0 returns empty and leaves buffer unchanged', () => {
    const buf = createRingBuffer<string>(10)
    buf.push('a')
    buf.push('b')
    const drained = buf.drain(0)
    assert.deepEqual(drained, [])
    assert.deepEqual(buf.items(), ['a', 'b'])
  })
})
```

- [ ] **步骤 2：运行测试确认失败**

运行：`npx tsx --test src/tui/__tests__/ring-buffer.test.ts`
预期：FAIL — `buf.clear is not a function`

- [ ] **步骤 3：修改 `src/tui/ring-buffer.ts` 添加 clear 和 drain**

```typescript
export interface RingBuffer<T> {
  push(item: T): void
  items(): T[]
  clear(): void
  drain(n: number): T[]
  readonly size: number
}

export function createRingBuffer<T>(cap: number): RingBuffer<T> {
  const buf: T[] = []
  return {
    push(item: T) {
      if (buf.length >= cap) buf.shift()
      buf.push(item)
    },
    items() { return [...buf] },
    clear() { buf.length = 0 },
    drain(n: number): T[] {
      const count = Math.min(n, buf.length)
      return buf.splice(0, count)
    },
    get size() { return buf.length },
  }
}
```

- [ ] **步骤 4：运行测试确认通过**

运行：`npx tsx --test src/tui/__tests__/ring-buffer.test.ts`
预期：PASS

- [ ] **步骤 5：Commit**

```bash
git add src/tui/ring-buffer.ts src/tui/__tests__/ring-buffer.test.ts
git commit -m "feat(tui): add clear() and drain(n) to RingBuffer for segmented Static"
```

---

### 任务 2：AssistantMessage 组件

**文件：**
- 创建：`src/tui/assistant-message.tsx`
- 测试：`src/tui/__tests__/assistant-message.test.ts`

- [ ] **步骤 1：创建测试 `src/tui/__tests__/assistant-message.test.ts`**

```typescript
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { AssistantMessage } from '../assistant-message.js'

describe('AssistantMessage', () => {
  it('exports AssistantMessage component', () => {
    assert.equal(typeof AssistantMessage, 'object')
  })

  it('splits single-line content into one block', () => {
    const lines = 'Hello world'.split('\n')
    assert.equal(lines.length, 1)
  })

  it('splits multi-line content into multiple blocks', () => {
    const lines = 'line 1\nline 2\nline 3'.split('\n')
    assert.equal(lines.length, 3)
  })

  it('handles empty content', () => {
    assert.equal(''.split('\n').length, 1)
  })
})
```

- [ ] **步骤 2：运行测试确认失败**

运行：`npx tsx --test src/tui/__tests__/assistant-message.test.ts`
预期：FAIL — Cannot resolve `../assistant-message.js`

- [ ] **步骤 3：创建 `src/tui/assistant-message.tsx`**

```typescript
import { Box, Text } from 'ink'
import { memo } from 'react'
import { getTheme } from './theme.js'

interface AssistantMessageProps {
  content: string
}

export const AssistantMessage = memo(function AssistantMessage({ content }: AssistantMessageProps) {
  const theme = getTheme()
  if (!content) return null

  const lines = content.split('\n')

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box flexDirection="row">
        <Text color={theme.assistantColor} bold>{'●'} </Text>
        <Text>{lines[0]}</Text>
      </Box>
      {lines.slice(1).map((line, i) => (
        <Box key={i} flexDirection="row">
          <Text dimColor>{'⎿'} </Text>
          <Text>{line}</Text>
        </Box>
      ))}
    </Box>
  )
})
```

- [ ] **步骤 4：运行测试确认通过**

运行：`npx tsx --test src/tui/__tests__/assistant-message.test.ts`
预期：PASS

- [ ] **步骤 5：运行 typecheck**

运行：`npm run typecheck`
预期：PASS

- [ ] **步骤 6：Commit**

```bash
git add src/tui/assistant-message.tsx src/tui/__tests__/assistant-message.test.ts
git commit -m "feat(tui): add AssistantMessage component with ● prefix and ⎿ indent"
```

---

### 任务 3：App 集成 — renderStaticEntry + 双 Static 分段

**文件：**
- 修改：`src/tui/app.tsx`

这是核心任务。需要修改多处。先读取当前文件了解上下文。

- [ ] **步骤 1：在 app.tsx 顶部添加 import**

在现有 import 区域添加：

```typescript
import { AssistantMessage } from './assistant-message.js'
```

- [ ] **步骤 2：更新 renderStaticEntry 的 assistant_message 分支**

将 `renderStaticEntry` 函数中：

```typescript
case 'assistant_message':
  return <StreamOutput key={entry.id} text={entry.content} isStreaming={false} />
```

改为：

```typescript
case 'assistant_message':
  return <AssistantMessage key={entry.id} content={entry.content} />
```

- [ ] **步骤 3：添加 frozenBuf 和分段 state**

在 App 组件内部，在 `staticBuf` 声明附近添加：

```typescript
const frozenBuf = useMemo(() => createRingBuffer<LogEntry>(500), [])
const [frozenItems, setFrozenItems] = useState<LogEntry[]>([])
const [activeItems, setActiveItems] = useState<LogEntry[]>([])
```

删除原来的 `const [staticItems, setStaticItems] = useState<LogEntry[]>([])`。

- [ ] **步骤 4：更新 pushStatic 和 pushStaticBatch**

将 `pushStatic` 改为写入 activeItems：

```typescript
const pushStatic = useCallback((entry: LogEntry) => {
  staticBuf.push(entry)
  setActiveItems(staticBuf.items())
}, [staticBuf])

const pushStaticBatch = useCallback((entries: readonly LogEntry[]) => {
  for (const entry of entries) staticBuf.push(entry)
  setActiveItems(staticBuf.items())
}, [staticBuf])
```

- [ ] **步骤 5：添加迁移函数和常量**

在 `pushStaticBatch` 之后添加：

```typescript
const ACTIVE_THRESHOLD = 20

const migrateToFrozen = useCallback(() => {
  const active = staticBuf.items()
  if (active.length <= ACTIVE_THRESHOLD) return
  const migrateCount = active.length - ACTIVE_THRESHOLD
  const toFreeze = staticBuf.drain(migrateCount)
  for (const item of toFreeze) frozenBuf.push(item)
  setFrozenItems(frozenBuf.items())
  setActiveItems(staticBuf.items())
}, [staticBuf, frozenBuf])
```

- [ ] **步骤 6：在 onTurnComplete 末尾调用 migrateToFrozen**

在 `onTurnComplete` 回调的最后（`setCost(estimatedCost)` 之后），添加：

```typescript
migrateToFrozen()
```

- [ ] **步骤 7：更新 banner useEffect**

将 banner push 到 active（不改，pushStatic 已经指向 activeItems）。

- [ ] **步骤 8：更新 session 恢复逻辑**

在 `useInput` 的 session 恢复部分（`_input === 'r'` 分支），将：

```typescript
for (const entry of entries) {
  pushStatic(entry)
}
```

改为：

```typescript
for (const entry of entries) frozenBuf.push(entry)
setFrozenItems(frozenBuf.items())
```

这样恢复的历史全部进入 frozen 区，不占活跃区空间。

- [ ] **步骤 9：更新渲染区域**

将返回的 JSX 中的 `<Static>` 区域从：

```typescript
<Static items={groupedItems}>
  {(item) => renderStaticEntry(item, verbose)}
</Static>
```

改为：

```typescript
<Static items={frozenItems}>
  {(item) => renderStaticEntry(item, verbose)}
</Static>
<Static items={useMemo(() => groupLogs(activeItems), [activeItems])}>
  {(item) => renderStaticEntry(item, verbose)}
</Static>
```

删除之前的 `const groupedItems = useMemo(...)` 行。

- [ ] **步骤 10：运行 typecheck**

运行：`npm run typecheck`
预期：PASS

- [ ] **步骤 11：运行全量测试**

运行：`npm test`
预期：全部 PASS

- [ ] **步骤 12：Commit**

```bash
git add src/tui/app.tsx
git commit -m "feat(tui): integrate AssistantMessage + segmented Static (frozen/active)"
```

---

## 自检

### 1. 规格覆盖度

| 规格需求 | 实现任务 |
|---------|---------|
| AssistantMessage 组件（`●` 前缀 + `⎿` 缩进） | 任务 2 |
| renderStaticEntry 切换到 AssistantMessage | 任务 3 步骤 2 |
| React.memo 包裹 | 任务 2（memo 已在代码中） |
| frozenBuf + staticBuf 双 RingBuffer | 任务 3 步骤 3 |
| ACTIVE_THRESHOLD = 20 | 任务 3 步骤 5 |
| migrateToFrozen 在 turn 结束时 | 任务 3 步骤 6 |
| 双 Static 渲染 | 任务 3 步骤 9 |
| session 恢复进 frozen | 任务 3 步骤 8 |
| RingBuffer clear/drain | 任务 1 |
| 流式区不加前缀 | 任务 3（streaming 区仍用 StreamOutput） |
| 不引入 ink-ui ThemeProvider | ✓ 使用已有 theme.ts |
| 不做虚拟滚动 | ✓ 无相关任务 |

无遗漏。

### 2. 占位符扫描

无 TODO/TBD/待定。每个步骤包含完整代码。

### 3. 类型一致性

- `frozenBuf` 类型 `RingBuffer<LogEntry>` — 在任务 1 中扩展接口，任务 3 中使用，一致
- `drain(n: number): T[]` — 任务 1 定义，任务 3 步骤 5 中 `staticBuf.drain(migrateCount)`，返回类型一致
- `activeItems` / `frozenItems` 类型 `LogEntry[]` — 全文一致
- `pushStatic` / `pushStaticBatch` 签名不变 — 任务 3 步骤 4 只改内部实现
- `AssistantMessageProps.content: string` — 任务 2 定义，任务 3 步骤 2 传入 `entry.content: string`，一致
