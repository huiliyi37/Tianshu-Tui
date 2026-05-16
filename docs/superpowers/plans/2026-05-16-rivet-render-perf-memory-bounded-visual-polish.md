# 渲染性能 + 内存有界化 + 视觉愉悦 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** Phase 2-3 of the pastel aesthetic design — fix rendering performance bottlenecks, add memory bounds to prevent long-session growth, and add visual polish (sparkline, gradient banner, spinner).

**架构：** 6 tasks targeting specific bottlenecks: cockpit snapshot memoization, staticItems ring buffer, SessionContext bounded collections, braille sparkline, theme-aware gradient, spinner animation. Each task is independent and testable in isolation.

**技术栈：** TypeScript, Ink 6, React, node:test, node:assert/strict

---

## 文件结构

| 操作 | 文件 | 职责 |
|------|------|------|
| 修改 | `src/tui/cockpit/state.ts` | Export a memoization-friendly version of snapshot builder |
| 修改 | `src/tui/app.tsx` | Ring buffer for staticItems, useMemo for cockpit snapshot, gradient banner |
| 修改 | `src/agent/context.ts` | Bounded collections (filesRead, filesModified, testResults, turnCacheHistory) |
| 修改 | `src/tui/summary-bar.tsx` | Braille sparkline for context token history |
| 修改 | `src/tui/agent-status.tsx` | Spinner animation for active phase |
| 测试 | `src/tui/__tests__/summary-bar.test.ts` | Sparkline rendering tests |
| 测试 | `src/agent/__tests__/context.test.ts` | Bounded collection tests |

---

### 任务 1：Cockpit snapshot memoization

**问题：** `CockpitView` 调用 `buildCockpitSnapshot()` 在每次渲染时都重建整个 snapshot（映射 trace events、verifications、context layers、MCP states）。Memo 包裹的子面板收到新对象引用，memo 失效。

**文件：**
- 修改：`src/tui/app.tsx`（`CockpitView` 组件，约 374 行）

- [x] **步骤 1：在 CockpitView 中用 useMemo 包裹 snapshot**

修改 `CockpitView` 组件：

```tsx
import { memo, useMemo } from 'react'

function CockpitView({ panel, agent, session, model, cacheHitRate, cost, summaryState, mcpManager }: CockpitViewProps) {
  const theme = getTheme()
  const snap = useMemo(
    () => buildCockpitSnapshot({ agent, session, model, cacheHitRate, cost, mcpManager }),
    [agent, session, model, cacheHitRate, cost, mcpManager],
  )
  const compactEvents = useMemo(() => session.getCompactEvents(), [session])
  // ... rest of render unchanged
```

确保 `useMemo` 的 import 已存在（从 react 导入）。如果 `CockpitView` 已经从 `react` 导入了 `memo`，加上 `useMemo`。

- [x] **步骤 2：运行 focused tests**

运行：

```bash
npm test -- src/tui/cockpit/__tests__
```

预期：PASS。

- [x] **步骤 3：运行 typecheck**

```bash
npm run typecheck
```

预期：PASS。

- [x] **步骤 4：Commit**

```bash
git add src/tui/app.tsx
git commit -m "perf(tui): memoize cockpit snapshot to prevent per-render rebuild"
```

---

### 任务 2：Ring buffer for staticItems

**问题：** `pushStatic` 每次 append 都做 `setStaticItems(prev => [...prev, entry])`，O(n) 拷贝且无上界。长会话后 staticItems 可能增长到数千条。

**文件：**
- 修改：`src/tui/app.tsx`（`pushStatic` callback，约 424 行）
- 测试：`src/tui/__tests__/ring-buffer.test.ts`

- [x] **步骤 1：编写 ring buffer 测试**

创建 `src/tui/__tests__/ring-buffer.test.ts`：

```typescript
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createRingBuffer } from '../ring-buffer.js'

describe('createRingBuffer', () => {
  it('appends items up to cap', () => {
    const buf = createRingBuffer<string>(3)
    buf.push('a')
    buf.push('b')
    assert.deepEqual(buf.items(), ['a', 'b'])
  })

  it('evicts oldest when cap exceeded', () => {
    const buf = createRingBuffer<string>(3)
    buf.push('a')
    buf.push('b')
    buf.push('c')
    buf.push('d')
    assert.deepEqual(buf.items(), ['b', 'c', 'd'])
  })

  it('handles cap of 1', () => {
    const buf = createRingBuffer<string>(1)
    buf.push('a')
    buf.push('b')
    assert.deepEqual(buf.items(), ['b'])
  })

  it('returns empty array when no items', () => {
    const buf = createRingBuffer<string>(5)
    assert.deepEqual(buf.items(), [])
  })
})
```

- [x] **步骤 2：运行测试验证失败**

```bash
npm test -- src/tui/__tests__/ring-buffer.test.ts
```

预期：FAIL，`ring-buffer.js` 不存在。

- [x] **步骤 3：实现 ring buffer**

创建 `src/tui/ring-buffer.ts`：

```typescript
export interface RingBuffer<T> {
  push(item: T): void
  items(): T[]
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
    get size() { return buf.length },
  }
}
```

- [x] **步骤 4：运行测试验证通过**

```bash
npm test -- src/tui/__tests__/ring-buffer.test.ts
```

预期：PASS。

- [x] **步骤 5：集成到 app.tsx**

在 `app.tsx` 中：
1. 添加 import: `import { createRingBuffer } from './ring-buffer.js'`
2. 替换 state 声明（约 397 行）：

```typescript
// BEFORE:
const [staticItems, setStaticItems] = useState<LogEntry[]>([])

// AFTER:
const staticBuf = useMemo(() => createRingBuffer<LogEntry>(500), [])
const [staticItems, setStaticItems] = useState<LogEntry[]>([])
```

3. 替换 `pushStatic`（约 424 行）：

```typescript
// BEFORE:
const pushStatic = useCallback((entry: LogEntry) => {
  setStaticItems(prev => [...prev, entry])
}, [])

// AFTER:
const pushStatic = useCallback((entry: LogEntry) => {
  staticBuf.push(entry)
  setStaticItems(staticBuf.items())
}, [staticBuf])
```

- [x] **步骤 6：运行 full test suite**

```bash
npm test
```

预期：PASS。

- [x] **步骤 7：Commit**

```bash
git add src/tui/ring-buffer.ts src/tui/__tests__/ring-buffer.test.ts src/tui/app.tsx
git commit -m "perf(tui): cap staticItems at 500 with ring buffer"
```

---

### 任务 3：SessionContext bounded collections

**问题：** `filesRead`、`filesModified`、`testResults`、`turnCacheHistory` 是 append-only 无界集合。长会话（2 小时+）会导致持续增长。

**文件：**
- 修改：`src/agent/context.ts`（`SessionContext` 类）
- 测试：`src/agent/__tests__/context.test.ts`

- [x] **步骤 1：编写 bounded collection 测试**

在 `src/agent/__tests__/context.test.ts` 中追加：

```typescript
describe('SessionContext bounded collections', () => {
  it('evicts oldest filesRead when cap exceeded', () => {
    const ctx = new SessionContext()
    for (let i = 0; i < 502; i++) {
      ctx.trackFileRead(`file-${i}.ts`)
    }
    const files = ctx.getFilesRead()
    assert.ok(files.length <= 500, `expected <= 500, got ${files.length}`)
    assert.ok(files.includes('file-501.ts'), 'should keep newest')
    assert.ok(!files.includes('file-0.ts'), 'should evict oldest')
  })

  it('evicts oldest filesModified when cap exceeded', () => {
    const ctx = new SessionContext()
    for (let i = 0; i < 502; i++) {
      ctx.trackFileModified(`mod-${i}.ts`)
    }
    const files = ctx.getFilesModified()
    assert.ok(files.length <= 500, `expected <= 500, got ${files.length}`)
  })

  it('evicts oldest testResults when cap exceeded', () => {
    const ctx = new SessionContext()
    for (let i = 0; i < 502; i++) {
      ctx.trackTestResult(i, 0)
    }
    const results = ctx.getTestResults()
    assert.ok(results.length <= 500, `expected <= 500, got ${results.length}`)
    // newest should be last
    assert.equal(results[results.length - 1]!.passed, 501)
  })

  it('evicts oldest turnCacheHistory when cap exceeded', () => {
    const ctx = new SessionContext()
    for (let i = 0; i < 502; i++) {
      ctx.recordTurnCache(i, { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 80, cache_creation_input_tokens: 20 })
    }
    const history = ctx.getCacheHistory()
    assert.ok(history.length <= 500, `expected <= 500, got ${history.length}`)
    assert.equal(history[history.length - 1]!.turn, 501)
  })
})
```

- [x] **步骤 2：运行测试验证失败**

```bash
npm test -- src/agent/__tests__/context.test.ts
```

预期：FAIL，collections grow beyond 500.

- [x] **步骤 3：实现 bounded eviction**

在 `src/agent/context.ts` 中：

1. 添加常量：

```typescript
const MAX_TRACKED_FILES = 500
const MAX_TEST_RESULTS = 500
const MAX_CACHE_HISTORY = 500
```

2. 将 `filesRead` 和 `filesModified` 从 `Set<string>` 改为有序结构。由于 `Set` 在 JS 中保持插入顺序，可以用删除最旧元素的方式：

修改 `trackFileRead`:

```typescript
trackFileRead(path: string): void {
  if (this.state.filesRead.has(path)) {
    this.state.filesRead.delete(path) // move to end
  }
  this.state.filesRead.add(path)
  while (this.state.filesRead.size > MAX_TRACKED_FILES) {
    const first = this.state.filesRead.values().next().value
    if (first !== undefined) this.state.filesRead.delete(first)
  }
}
```

修改 `trackFileModified` 同理。

3. 修改 `trackTestResult`:

```typescript
trackTestResult(passed: number, failed: number): void {
  this.state.testResults.push({ passed, failed })
  if (this.state.testResults.length > MAX_TEST_RESULTS) {
    this.state.testResults = this.state.testResults.slice(-MAX_TEST_RESULTS)
  }
}
```

4. 修改 `recordTurnCache`:

```typescript
recordTurnCache(turn: number, usage: Usage): void {
  this.state.turnCacheHistory.push({
    turn,
    cacheRead: usage.cache_read_input_tokens,
    cacheCreation: usage.cache_creation_input_tokens,
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
  })
  if (this.state.turnCacheHistory.length > MAX_CACHE_HISTORY) {
    this.state.turnCacheHistory = this.state.turnCacheHistory.slice(-MAX_CACHE_HISTORY)
  }
}
```

- [x] **步骤 4：运行测试验证通过**

```bash
npm test -- src/agent/__tests__/context.test.ts
```

预期：PASS。

- [x] **步骤 5：运行 full test suite**

```bash
npm test
```

预期：PASS。

- [x] **步骤 6：Commit**

```bash
git add src/agent/context.ts src/agent/__tests__/context.test.ts
git commit -m "perf(agent): bound SessionContext collections at 500 entries"
```

---

### 任务 4：Braille context sparkline

**问题：** SummaryBar 只显示 context 百分比数字，缺少趋势可视化。用户无法一眼看出 token 是在增长还是稳定。

**文件：**
- 修改：`src/tui/summary-bar.tsx`（`formatSummaryLine1` 和 `SummaryBar` 组件）
- 测试：`src/tui/__tests__/summary-bar.test.ts`

- [x] **步骤 1：编写 sparkline 测试**

在 `src/tui/__tests__/summary-bar.test.ts` 中追加（如果文件已存在则追加，否则创建）：

```typescript
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { brailleSparkline } from '../summary-bar.js'

describe('brailleSparkline', () => {
  it('renders empty sparkline for no data', () => {
    assert.equal(brailleSparkline([]), '')
  })

  it('renders sparkline for single value', () => {
    const result = brailleSparkline([0.5])
    assert.ok(result.length > 0)
  })

  it('renders sparkline for increasing values', () => {
    const result = brailleSparkline([0.1, 0.2, 0.3, 0.5, 0.7, 0.9])
    assert.ok(result.length > 0)
    // Should contain braille characters (U+2800 block)
    assert.ok(/[⠀-⣿]/.test(result))
  })

  it('renders sparkline for flat values', () => {
    const result = brailleSparkline([0.5, 0.5, 0.5, 0.5])
    assert.ok(result.length > 0)
  })

  it('clamps values outside 0-1 range', () => {
    const result = brailleSparkline([-0.1, 0.5, 1.5])
    assert.ok(result.length > 0)
  })
})
```

- [x] **步骤 2：运行测试验证失败**

```bash
npm test -- src/tui/__tests__/summary-bar.test.ts
```

预期：FAIL，`brailleSparkline` 不存在。

- [x] **步骤 3：实现 braille sparkline**

在 `src/tui/summary-bar.tsx` 中添加：

```typescript
// Braille sparkline: renders values 0-1 as braille dot columns
// Each braille char encodes a 2-wide x 4-tall dot grid
// We use pairs of values to fill one braille column
export function brailleSparkline(values: number[]): string {
  if (values.length === 0) return ''

  // Braille base: U+2800, dots pattern: 1=bottom-left, 2=mid-left, 4=top-left, 8=mid-right, 16=bottom-right, 32=mid-right2, 64=top-right, 128=mid-right2
  // Simplified: use 4 vertical levels per column, 2 columns per char
  const BRAILLE_BASE = 0x2800
  // Dot positions for left column (bottom to top): bit 0, 1, 2, 6
  // Dot positions for right column (bottom to top): bit 3, 4, 5, 7
  const leftDots = [0, 1, 2, 6]   // bit positions for left column
  const rightDots = [3, 4, 5, 7]  // bit positions for right column

  const chars: string[] = []
  for (let i = 0; i < values.length; i += 2) {
    let pattern = 0
    // Left column
    const lv = Math.max(0, Math.min(1, values[i] ?? 0))
    const lLevel = Math.round(lv * 3) // 0-3
    for (let d = 0; d <= lLevel; d++) {
      pattern |= 1 << leftDots[d]!
    }
    // Right column
    const rv = Math.max(0, Math.min(1, values[i + 1] ?? values[i] ?? 0))
    const rLevel = Math.round(rv * 3)
    for (let d = 0; d <= rLevel; d++) {
      pattern |= 1 << rightDots[d]!
    }
    chars.push(String.fromCodePoint(BRAILLE_BASE + pattern))
  }
  return chars.join('')
}
```

- [x] **步骤 4：运行测试验证通过**

```bash
npm test -- src/tui/__tests__/summary-bar.test.ts
```

预期：PASS。

- [x] **步骤 5：集成 sparkline 到 SummaryBar**

1. 在 `SummaryState` 接口中添加可选的 token history：

```typescript
export interface SummaryState {
  // ... existing fields ...
  tokenHistory?: number[]  // last N context percentages (0-1)
}
```

2. 在 `formatSummaryLine1` 中，如果 `tokenHistory` 存在，在 context bar 后面追加 sparkline：

```typescript
export function formatSummaryLine1(state: SummaryState): string {
  const task = truncate(state.task || 'working', 30)
  const phase = state.phase
  const steps = state.totalSteps > 0 ? ` (${state.stepCount}/${state.totalSteps})` : ''
  const pct = Math.round(state.contextPct * 100)
  const elapsed = formatElapsed(state.elapsedMs)
  const spark = state.tokenHistory && state.tokenHistory.length > 1
    ? ` ${brailleSparkline(state.tokenHistory)}`
    : ''
  return `◆ ${task} → ${phase}${steps} │ ${contextBar(state.contextPct)} ${pct}%${spark} │ ${elapsed}`
}
```

3. 在 `SummaryBar` 组件的 JSX 中对应位置也加上 sparkline：

```tsx
<Text color={ctxColor} bold={state.contextPct >= 0.95}>
  {contextBar(state.contextPct)} {Math.round(state.contextPct * 100)}%
</Text>
{state.tokenHistory && state.tokenHistory.length > 1 && (
  <Text color={theme.dim}> {brailleSparkline(state.tokenHistory)}</Text>
)}
```

- [x] **步骤 6：传递 tokenHistory 从 app.tsx**

在 `app.tsx` 中，构建 `summaryState` 时添加 `tokenHistory`。找到 `setSummaryState` 调用的位置，添加 token history 跟踪：

在 App 组件中添加一个 ref 来累积 token 百分比：

```typescript
const tokenHistoryRef = useRef<number[]>([])

// 在每次更新 summaryState 时，追加 contextPct：
// (在 onTurnComplete 或 flushStream 等更新 summaryState 的地方)
tokenHistoryRef.current.push(currentTokens / maxTokens)
if (tokenHistoryRef.current.length > 20) {
  tokenHistoryRef.current = tokenHistoryRef.current.slice(-20)
}
```

然后在构建 summaryState 时传入：

```typescript
const summaryState: SummaryState = {
  // ... existing fields ...
  tokenHistory: tokenHistoryRef.current,
}
```

- [x] **步骤 7：运行 full test suite + typecheck**

```bash
npm run typecheck && npm test
```

预期：PASS。

- [x] **步骤 8：Commit**

```bash
git add src/tui/summary-bar.tsx src/tui/__tests__/summary-bar.test.ts src/tui/app.tsx
git commit -m "feat(tui): braille sparkline for context token trend in SummaryBar"
```

---

### 任务 5：Theme-aware gradient banner

**问题：** 启动 banner 使用硬编码的赛博色 `['#00ffcc', '#7b2fff']`，不随主题切换。

**文件：**
- 修改：`src/tui/app.tsx`（gradient banner，约 495 行）

- [x] **步骤 1：修改 banner 使用主题色**

找到 banner 渲染代码（约 495 行）：

```typescript
// BEFORE:
const banner = gradient(['#00ffcc', '#7b2fff'])('◆ R I V E T')

// AFTER:
const theme = getTheme()
const banner = gradient([theme.primary, theme.secondary])('◆ R I V E T')
```

确保 `getTheme` 已导入（应该已经有了）。

- [x] **步骤 2：运行 typecheck**

```bash
npm run typecheck
```

预期：PASS。

- [x] **步骤 3：Commit**

```bash
git add src/tui/app.tsx
git commit -m "feat(tui): gradient banner uses active theme colors"
```

---

### 任务 6：Spinner animation for AgentStatus

**问题：** `AgentStatus` 显示静态的 phase label（"Searching…"、"Writing…"），缺少动态感。

**文件：**
- 修改：`src/tui/agent-status.tsx`（`AgentStatus` 组件）

- [x] **步骤 1：添加 spinner frames**

在 `agent-status.tsx` 顶部添加：

```typescript
const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
```

- [x] **步骤 2：在 AgentStatus 中使用 spinner**

修改 `AgentStatus` 组件，将 `now` state 同时用于 spinner 帧选择：

```typescript
export const AgentStatus = memo(function AgentStatus({ isStreaming, startMs, tokenEstimate, thinkingTime, tools }: AgentStatusProps) {
  const [tick, setTick] = useState(0)

  useEffect(() => {
    if (!isStreaming) return
    const id = setInterval(() => setTick(t => t + 1), 120)
    return () => clearInterval(id)
  }, [isStreaming])

  if (!isStreaming) return null

  const now = Date.now()
  const elapsed = now - startMs
  const spinner = SPINNER_FRAMES[tick % SPINNER_FRAMES.length]!
  const phase = phaseLabel(tools, thinkingTime > 0 && tools.length === 0)

  // ... rest of component uses `spinner` and `now` instead of `now` state
```

在 JSX 中，将 phase label 前面加上 spinner：

```tsx
// BEFORE:
<Text bold color="cyan">{phase}</Text>

// AFTER:
<Text bold color="cyan">{spinner} {phase}</Text>
```

注意：将原来的 `const [now, setNow] = useState(Date.now())` 和相关的 `setInterval` 合并为上面的 `tick` 方式，同时用 `tick` 计算 elapsed 时间。

- [x] **步骤 3：运行 typecheck + tests**

```bash
npm run typecheck && npm test
```

预期：PASS。

- [x] **步骤 4：Commit**

```bash
git add src/tui/agent-status.tsx
git commit -m "feat(tui): spinner animation in AgentStatus phase label"
```

---

### 任务 7：Final validation + README update

**文件：**
- 修改：`README.md`

- [x] **步骤 1：更新 README**

在 Features 列表中添加：

```markdown
- **Pastel theme** — Soft, pleasant color palette (default); switchable to cyberpunk via `/theme cyberpunk`
- **Rendering optimization** — Memoized cockpit snapshot, bounded staticItems ring buffer (500 cap)
- **Memory safety** — SessionContext collections capped at 500 entries (filesRead, filesModified, testResults, cacheHistory)
- **Braille sparkline** — Context token trend visualization in SummaryBar
- **Spinner animation** — Rotating braille spinner in AgentStatus during streaming
```

- [x] **步骤 2：运行 full validation**

```bash
npm run typecheck && npm test && npm run build
```

预期：全部 PASS。

- [x] **步骤 3：Check for secrets**

```bash
git diff -- src docs README.md | grep -Ei "sk-[a-zA-Z0-9]|api[_-]?key\s*=|password\s*=|secret\s*=" || true
```

预期：无命中。

- [x] **步骤 4：Commit**

```bash
git add README.md
git commit -m "docs: document rendering perf, memory bounds, and visual polish"
```

---

## 自检

### 规格覆盖度

- Cockpit snapshot memoization：任务 1 覆盖
- staticItems ring buffer：任务 2 覆盖
- SessionContext bounded collections：任务 3 覆盖
- Braille sparkline：任务 4 覆盖
- Gradient banner theme-aware：任务 5 覆盖
- Spinner animation：任务 6 覆盖
- README + final validation：任务 7 覆盖

### 占位符扫描

无"待定"、"TODO"、"后续实现"。每个代码步骤都有完整代码块。

### 类型一致性

- `RingBuffer<T>` 在任务 2 定义，在任务 2 步骤 5 使用
- `SummaryState.tokenHistory` 在任务 4 定义，在任务 4 步骤 6 从 app.tsx 传入
- `brailleSparkline` 在任务 4 定义，在任务 4 步骤 5 集成到 SummaryBar
- `SPINNER_FRAMES` 在任务 6 定义，在任务 6 步骤 2 使用

---

计划已完成并保存到 `docs/superpowers/plans/2026-05-16-rivet-render-perf-memory-bounded-visual-polish.md`。两种执行方式：

**1. 子代理驱动（推荐）** - 每个任务调度一个新的子代理，任务间进行审查，快速迭代

**2. 内联执行** - 在当前会话中使用 executing-plans 执行任务，批量执行并设有检查点

选哪种方式？
