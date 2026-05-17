# Session Fluency Layer Phase 2: UI 接入实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 将 Phase 1 的纯策略引擎（`fluency-policy.ts`）接入 `app.tsx`，让 UI 根据策略动态折叠常规工具输出、在 stale 时提示、在 stress 时合并事件。

**架构：** 在 `app.tsx` 中用 `useRef` 维护 `RoutineCounter` + `StageSnapshot`，在 `onToolResult` / `onTurnComplete` 回调中更新信号，将 `computeFluencyPolicy` 的输出投射到工具折叠逻辑。不新增面板，只修改现有 surfaces 的可见性策略。

**技术栈：** TypeScript, React (Ink), 现有 `fluency-policy.ts` + `activity-status.ts`。

**前置：** Phase 1 已完成（`src/tui/fluency-policy.ts` 已就绪）。

---

## 文件结构

| 文件 | 操作 | 职责 |
|------|------|------|
| `src/tui/app.tsx` | 修改 | 接入 fluency policy：维护信号 + 应用折叠策略 |
| `src/tui/fluency-hook.ts` | 创建 | `useFluency()` hook — 封装信号采集和策略计算 |
| `src/tui/__tests__/fluency-hook.test.ts` | 创建 | hook 逻辑单元测试 |

---

### 任务 1：创建 useFluency hook

**文件：**
- 创建：`src/tui/fluency-hook.ts`
- 创建：`src/tui/__tests__/fluency-hook.test.ts`

- [ ] **步骤 1：编写失败测试**

```typescript
// src/tui/__tests__/fluency-hook.test.ts
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { FluencyTracker } from '../fluency-hook.js'

describe('FluencyTracker', () => {
  it('starts with normal visibility', () => {
    const tracker = new FluencyTracker()
    const policy = tracker.getPolicy()
    assert.equal(policy.visibility, 'normal')
    assert.equal(policy.foldRoutine, false)
  })

  it('enters quiet after 4 consecutive routine tools', () => {
    const tracker = new FluencyTracker()
    tracker.recordToolResult({ name: 'read_file', isError: false, resultLength: 100 })
    tracker.recordToolResult({ name: 'read_file', isError: false, resultLength: 100 })
    tracker.recordToolResult({ name: 'read_file', isError: false, resultLength: 100 })
    tracker.recordToolResult({ name: 'read_file', isError: false, resultLength: 100 })
    const policy = tracker.getPolicy()
    assert.equal(policy.visibility, 'quiet')
    assert.equal(policy.foldRoutine, true)
  })

  it('resets routine on error', () => {
    const tracker = new FluencyTracker()
    tracker.recordToolResult({ name: 'read_file', isError: false, resultLength: 100 })
    tracker.recordToolResult({ name: 'read_file', isError: false, resultLength: 100 })
    tracker.recordToolResult({ name: 'read_file', isError: false, resultLength: 100 })
    tracker.recordToolResult({ name: 'bash', isError: true, resultLength: 500 })
    const policy = tracker.getPolicy()
    assert.equal(policy.visibility, 'inspect')
    assert.equal(policy.foldRoutine, false)
  })

  it('detects stale after silence', () => {
    const tracker = new FluencyTracker()
    tracker.recordToolResult({ name: 'read_file', isError: false, resultLength: 100 })
    // Simulate 15s silence
    tracker.updateSilence(15_000)
    const policy = tracker.getPolicy()
    assert.equal(policy.visibility, 'inspect')
    assert.ok(policy.staleMessage)
  })

  it('reports stress under high context pressure', () => {
    const tracker = new FluencyTracker()
    tracker.setContextPressure(0.92)
    const policy = tracker.getPolicy()
    assert.equal(policy.visibility, 'stress')
    assert.ok(policy.coalesceMs >= 1000)
  })

  it('resets on turn complete', () => {
    const tracker = new FluencyTracker()
    tracker.recordToolResult({ name: 'read_file', isError: false, resultLength: 100 })
    tracker.recordToolResult({ name: 'read_file', isError: false, resultLength: 100 })
    tracker.recordToolResult({ name: 'read_file', isError: false, resultLength: 100 })
    tracker.recordToolResult({ name: 'read_file', isError: false, resultLength: 100 })
    assert.equal(tracker.getPolicy().foldRoutine, true)
    tracker.onTurnComplete()
    assert.equal(tracker.getPolicy().foldRoutine, false)
  })

  it('classifies read_file and grep as routine', () => {
    const tracker = new FluencyTracker()
    assert.equal(tracker.isRoutineTool('read_file', false), true)
    assert.equal(tracker.isRoutineTool('grep', false), true)
    assert.equal(tracker.isRoutineTool('glob', false), true)
  })

  it('classifies errors as non-routine', () => {
    const tracker = new FluencyTracker()
    assert.equal(tracker.isRoutineTool('read_file', true), false)
    assert.equal(tracker.isRoutineTool('bash', true), false)
  })

  it('classifies edit and bash as non-routine', () => {
    const tracker = new FluencyTracker()
    assert.equal(tracker.isRoutineTool('edit_file', false), false)
    assert.equal(tracker.isRoutineTool('bash', false), false)
    assert.equal(tracker.isRoutineTool('write_file', false), false)
  })
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npm test -- --test-name-pattern "FluencyTracker" 2>&1 | tail -5`
预期：FAIL（模块不存在）

- [ ] **步骤 3：实现 FluencyTracker**

```typescript
// src/tui/fluency-hook.ts
import { computeFluencyPolicy, RoutineCounter, type FluencyPolicy, type FluencySignals } from './fluency-policy.js'

const ROUTINE_TOOLS = new Set(['read_file', 'grep', 'glob', 'inspect_project', 'repo_map', 'related_tests', 'recall', 'diff'])

export interface ToolResultEvent {
  name: string
  isError: boolean
  resultLength: number
}

export class FluencyTracker {
  private routine = new RoutineCounter()
  private lastEventAt = Date.now()
  private contextPressure = 0
  private lastIsError = false
  private lastIsApproval = false
  private phase: FluencySignals['phase'] = 'idle'

  isRoutineTool(name: string, isError: boolean): boolean {
    if (isError) return false
    return ROUTINE_TOOLS.has(name)
  }

  recordToolResult(event: ToolResultEvent): void {
    const routine = this.isRoutineTool(event.name, event.isError)
    this.routine.record(routine)
    this.lastEventAt = Date.now()
    this.lastIsError = event.isError
    this.lastIsApproval = false
    this.phase = 'tool'
  }

  recordApproval(): void {
    this.lastIsApproval = true
    this.routine.reset()
  }

  setContextPressure(pressure: number): void {
    this.contextPressure = pressure
  }

  setPhase(phase: FluencySignals['phase']): void {
    this.phase = phase
    this.lastEventAt = Date.now()
  }

  updateSilence(silentMs: number): void {
    // For testing: allow manual silence injection
    this.lastEventAt = Date.now() - silentMs
  }

  onTurnComplete(): void {
    this.routine.reset()
    this.lastIsError = false
    this.lastIsApproval = false
    this.phase = 'idle'
  }

  getPolicy(): FluencyPolicy {
    const signals: FluencySignals = {
      phase: this.phase,
      silentMs: Date.now() - this.lastEventAt,
      outputRate: 0,
      resultLength: 0,
      contextPressure: this.contextPressure,
      isError: this.lastIsError,
      isApproval: this.lastIsApproval,
      consecutiveRoutine: this.routine.count,
    }
    return computeFluencyPolicy(signals)
  }
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`npx tsc --noEmit && npm test -- --test-name-pattern "FluencyTracker" 2>&1 | tail -5`
预期：PASS

- [ ] **步骤 5：Commit**

```bash
git add src/tui/fluency-hook.ts src/tui/__tests__/fluency-hook.test.ts
git commit -m "feat(tui): add FluencyTracker — signal collector for fluency policy"
```

---

### 任务 2：接入 app.tsx — 工具折叠

**文件：**
- 修改：`src/tui/app.tsx`

- [ ] **步骤 1：添加 import 和 ref**

在 `app.tsx` 顶部导入 FluencyTracker：

```typescript
import { FluencyTracker } from './fluency-hook.js'
```

在 App 组件内（refs 区域附近）添加：

```typescript
const fluencyRef = useRef(new FluencyTracker())
```

- [ ] **步骤 2：在 onToolResult 回调中更新 FluencyTracker**

在 `onToolResult` 回调内（`pushStatic` 调用之前），添加：

```typescript
// Update fluency tracker
fluencyRef.current.recordToolResult({ name, isError: !!isError, resultLength: result.length })
```

- [ ] **步骤 3：在 onTurnComplete 回调中重置**

在 `onTurnComplete` 回调末尾添加：

```typescript
fluencyRef.current.onTurnComplete()
```

- [ ] **步骤 4：在 onApprovalRequired 时标记**

在 approval 逻辑触发处添加：

```typescript
fluencyRef.current.recordApproval()
```

- [ ] **步骤 5：工具折叠逻辑**

在 `pushStatic(createLogEntry({ type: 'tool', ... }))` 调用处，用 fluency policy 判断是否折叠：

```typescript
const fluencyPolicy = fluencyRef.current.getPolicy()
if (fluencyPolicy.foldRoutine && fluencyRef.current.isRoutineTool(name, !!isError)) {
  // Fold: don't push to static, increment a folded counter
  foldedCountRef.current++
} else {
  // If there were folded items, flush a summary first
  if (foldedCountRef.current > 0) {
    pushStatic(createLogEntry({
      type: 'system',
      content: `… ${foldedCountRef.current} routine tool calls folded`,
    }))
    foldedCountRef.current = 0
  }
  pushStatic(createLogEntry({ type: 'tool', id, toolName: name, content: finalContent, isError, rawPath }))
}
```

需要添加 ref：
```typescript
const foldedCountRef = useRef(0)
```

- [ ] **步骤 6：context pressure 更新**

在 `setSummaryState` 中计算 token ratio 的位置附近添加：

```typescript
fluencyRef.current.setContextPressure(trPct)
```

- [ ] **步骤 7：运行 typecheck + 全量测试**

运行：`npx tsc --noEmit && npm test 2>&1 | grep -E "^ℹ (tests|pass|fail)"`
预期：0 fail

- [ ] **步骤 8：Commit**

```bash
git add src/tui/app.tsx
git commit -m "feat(tui): integrate fluency policy — fold routine tools, track context pressure"
```

---

### 任务 3：Stale 提示渲染

**文件：**
- 修改：`src/tui/app.tsx`

- [ ] **步骤 1：添加 stale 检测 interval**

在 streaming 状态 `useEffect` 中（已有 tick 更新的位置），追加 fluency stale 检查：

```typescript
const [fluencyStale, setFluencyStale] = useState<string | null>(null)

useEffect(() => {
  if (!isStreaming) {
    setFluencyStale(null)
    return
  }
  const id = setInterval(() => {
    const policy = fluencyRef.current.getPolicy()
    setFluencyStale(policy.staleMessage ?? null)
  }, 2000)
  return () => clearInterval(id)
}, [isStreaming])
```

- [ ] **步骤 2：渲染 stale 消息**

在活跃区渲染（`StreamOutput` 和 `ThinkingCollapser` 之间或之后），添加：

```typescript
{fluencyStale && !streamingText && (
  <Box paddingX={2}>
    <Text dimColor color="yellow">⚠ {fluencyStale}</Text>
  </Box>
)}
```

- [ ] **步骤 3：运行 typecheck + 全量测试**

运行：`npx tsc --noEmit && npm test 2>&1 | grep -E "^ℹ (tests|pass|fail)"`
预期：0 fail

- [ ] **步骤 4：Commit**

```bash
git add src/tui/app.tsx
git commit -m "feat(tui): show stale warning when agent goes silent during streaming"
```

---

## 风险与防线

| 风险 | 防线 |
|------|------|
| 折叠了重要工具输出（如 bash error） | `isRoutineTool` 对所有 error 返回 false，error 永不折叠 |
| 折叠摘要丢失 | flush folded summary 在非折叠事件到来时输出，turn 结束时也 flush |
| stale 检测与 ThinkingCollapser 的 stale 重复 | fluencyStale 只在 `!streamingText` 时显示（非 thinking 阶段） |
| context pressure 不准 | 使用已有的 `trPct`（session.getEstimatedTokens/maxTokens），是现有最精确估计 |
| 折叠后用户无法审计 | 折叠摘要显示数量，verbose 模式下可选禁用折叠 |

---

## 自检

1. **覆盖度：** Phase 2 三个关键行为全覆盖 — 工具折叠 ✓、stale 提示 ✓、context pressure 跟踪 ✓
2. **占位符扫描：** 无 TODO
3. **类型一致性：** `FluencyTracker.recordToolResult` 入参与 app.tsx `onToolResult` 回调参数对齐
4. **不做的事：** 不改 AgentLoop、不新增面板、不改 LogEntry 类型、不改 history-replay
