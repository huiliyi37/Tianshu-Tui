# Execution Resilience Layer 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [x]`）语法来跟踪进度。

**目标：** 从 loop.ts 提取 TurnHarness 抽象，加入 tool retry + trajectory recording + task-state injection，提升长任务执行韧性。

**架构：** TurnHarness 封装 tool 执行逻辑（retry、trajectory、hooks），loop.ts 只负责 turn 编排。Task-state 从 trajectory 提取后注入 volatile context。

**技术栈：** TypeScript, node:test, node:assert/strict

---

## 文件结构

| 操作 | 文件 | 职责 |
|------|------|------|
| 创建 | `src/agent/turn-harness.ts` | TurnHarness 类：封装 tool 执行 + retry + hooks |
| 创建 | `src/agent/trajectory.ts` | TrajectoryRecorder：记录 tool 执行轨迹 |
| 创建 | `src/agent/task-state.ts` | extractTaskState()：从 trajectory 提取任务进度 |
| 创建 | `src/agent/__tests__/turn-harness.test.ts` | TurnHarness 单元测试 |
| 创建 | `src/agent/__tests__/trajectory.test.ts` | TrajectoryRecorder 单元测试 |
| 创建 | `src/agent/__tests__/task-state.test.ts` | Task state 提取测试 |
| 修改 | `src/agent/loop.ts:263-388` | 用 TurnHarness 替代内联 tool 执行 |
| 修改 | `src/agent/failure-classifier.ts` | 新增 isTransient() 判断函数 |
| 修改 | `src/prompt/volatile.ts` | 新增 `<task-progress>` section |

---

### 任务 1：TrajectoryRecorder

**文件：**
- 创建：`src/agent/trajectory.ts`
- 测试：`src/agent/__tests__/trajectory.test.ts`

- [x] **步骤 1：编写失败的测试**

```typescript
// src/agent/__tests__/trajectory.test.ts
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { TrajectoryRecorder } from '../trajectory.js'

describe('TrajectoryRecorder', () => {
  it('records entries and returns them', () => {
    const tr = new TrajectoryRecorder()
    tr.record({ turn: 1, tool: 'read_file', target: 'src/a.ts', durationMs: 50, status: 'success', inputSummary: 'path=src/a.ts', resultSummary: 'file content...' })
    assert.equal(tr.getEntries().length, 1)
    assert.equal(tr.getEntries()[0]!.tool, 'read_file')
  })

  it('summarizes stats correctly', () => {
    const tr = new TrajectoryRecorder()
    tr.record({ turn: 1, tool: 'read_file', target: 'a.ts', durationMs: 30, status: 'success', inputSummary: '', resultSummary: '' })
    tr.record({ turn: 1, tool: 'edit_file', target: 'b.ts', durationMs: 70, status: 'failed', errorClass: 'timeout', inputSummary: '', resultSummary: '' })
    tr.record({ turn: 2, tool: 'bash', target: 'npm test', durationMs: 200, status: 'retried-success', inputSummary: '', resultSummary: '' })
    const s = tr.summarize()
    assert.equal(s.totalTools, 3)
    assert.equal(s.failures, 1)
    assert.equal(s.retries, 1)
    assert.equal(s.avgDurationMs, 100)
  })

  it('exports as JSON string', () => {
    const tr = new TrajectoryRecorder()
    tr.record({ turn: 1, tool: 'grep', target: 'pattern', durationMs: 10, status: 'success', inputSummary: '', resultSummary: '' })
    const json = tr.exportJson()
    const parsed = JSON.parse(json)
    assert.equal(parsed.length, 1)
  })

  it('resets all entries', () => {
    const tr = new TrajectoryRecorder()
    tr.record({ turn: 1, tool: 'bash', target: 'ls', durationMs: 5, status: 'success', inputSummary: '', resultSummary: '' })
    tr.reset()
    assert.equal(tr.getEntries().length, 0)
  })
})
```

- [x] **步骤 2：运行测试验证失败**

运行：`npm test -- --test-path-pattern trajectory.test 2>&1 | tail -5`
预期：FAIL，"Cannot find module '../trajectory.js'"

- [x] **步骤 3：编写实现**

```typescript
// src/agent/trajectory.ts
export interface TrajectoryEntry {
  turn: number
  tool: string
  target: string
  durationMs: number
  status: 'success' | 'failed' | 'retried-success' | 'retried-failed'
  errorClass?: string
  inputSummary: string
  resultSummary: string
}

export class TrajectoryRecorder {
  private entries: TrajectoryEntry[] = []

  record(entry: TrajectoryEntry): void {
    this.entries.push(entry)
  }

  getEntries(): TrajectoryEntry[] {
    return this.entries
  }

  summarize(): { totalTools: number; failures: number; retries: number; avgDurationMs: number } {
    const total = this.entries.length
    const failures = this.entries.filter(e => e.status === 'failed' || e.status === 'retried-failed').length
    const retries = this.entries.filter(e => e.status.startsWith('retried')).length
    const avgDurationMs = total > 0 ? Math.round(this.entries.reduce((s, e) => s + e.durationMs, 0) / total) : 0
    return { totalTools: total, failures, retries, avgDurationMs }
  }

  exportJson(): string {
    return JSON.stringify(this.entries)
  }

  reset(): void {
    this.entries = []
  }
}
```

- [x] **步骤 4：运行测试验证通过**

运行：`npm test -- --test-path-pattern trajectory.test 2>&1 | tail -5`
预期：PASS

- [x] **步骤 5：Commit**

```bash
git add src/agent/trajectory.ts src/agent/__tests__/trajectory.test.ts
git commit -m "feat(agent): add TrajectoryRecorder for tool execution tracing"
```

---

### 任务 2：isTransient() 判断函数

**文件：**
- 修改：`src/agent/failure-classifier.ts`
- 测试：现有 `src/agent/__tests__/failure-classifier.test.ts`（追加测试）

- [x] **步骤 1：编写失败的测试**

在现有测试文件末尾追加：

```typescript
// 追加到 src/agent/__tests__/failure-classifier.test.ts
import { isTransient } from '../failure-classifier.js'

describe('isTransient', () => {
  it('returns true for timeout class', () => {
    assert.equal(isTransient('timeout'), true)
  })

  it('returns true for flaky class', () => {
    assert.equal(isTransient('flaky'), true)
  })

  it('returns false for type_error', () => {
    assert.equal(isTransient('type_error'), false)
  })

  it('returns false for assertion', () => {
    assert.equal(isTransient('assertion'), false)
  })

  it('classifies ECONNRESET as transient from raw error text', () => {
    assert.equal(isTransient(classifyFailure('Error: ECONNRESET connection reset').class), true)
  })
})
```

- [x] **步骤 2：运行测试验证失败**

运行：`npm test -- --test-path-pattern failure-classifier.test 2>&1 | tail -5`
预期：FAIL，"isTransient is not exported"

- [x] **步骤 3：编写实现**

在 `src/agent/failure-classifier.ts` 末尾追加：

```typescript
const TRANSIENT_CLASSES: ReadonlySet<FailureClass> = new Set(['timeout', 'flaky'])

export function isTransient(failureClass: FailureClass): boolean {
  return TRANSIENT_CLASSES.has(failureClass)
}
```

同时在 `classifyFailure` 函数中，在 timeout 判断之后添加网络错误识别：

```typescript
  // 4b. Network/transient errors
  if (/ECONNRESET|ECONNREFUSED|ETIMEDOUT|socket hang up|fetch failed/i.test(errorText)) {
    return { class: 'timeout', suggestion: 'Transient network error. Retry may succeed.', confidence: 0.85 }
  }
```

- [x] **步骤 4：运行测试验证通过**

运行：`npm test -- --test-path-pattern failure-classifier.test 2>&1 | tail -5`
预期：PASS

- [x] **步骤 5：Commit**

```bash
git add src/agent/failure-classifier.ts src/agent/__tests__/failure-classifier.test.ts
git commit -m "feat(agent): add isTransient() for retry decision in TurnHarness"
```

---

### 任务 3：TurnHarness

**文件：**
- 创建：`src/agent/turn-harness.ts`
- 测试：`src/agent/__tests__/turn-harness.test.ts`

- [x] **步骤 1：编写失败的测试**

```typescript
// src/agent/__tests__/turn-harness.test.ts
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { TurnHarness, type TurnHarnessConfig } from '../turn-harness.js'
import { TrajectoryRecorder } from '../trajectory.js'

function makeConfig(overrides?: Partial<TurnHarnessConfig>): TurnHarnessConfig {
  return {
    maxRetries: 1,
    retryableClasses: ['timeout', 'flaky'],
    ...overrides,
  }
}

describe('TurnHarness', () => {
  it('executes a tool and records trajectory', async () => {
    const trajectory = new TrajectoryRecorder()
    const harness = new TurnHarness(makeConfig(), trajectory)
    const result = await harness.executeTool({
      id: 'tu1',
      name: 'read_file',
      input: { file_path: 'src/a.ts' },
      execute: async () => ({ content: 'file content' }),
      classify: () => undefined,
    })
    assert.equal(result.content, 'file content')
    assert.equal(result.isError, false)
    assert.equal(trajectory.getEntries().length, 1)
    assert.equal(trajectory.getEntries()[0]!.status, 'success')
  })

  it('retries transient errors once then succeeds', async () => {
    const trajectory = new TrajectoryRecorder()
    const harness = new TurnHarness(makeConfig(), trajectory)
    let calls = 0
    const result = await harness.executeTool({
      id: 'tu2',
      name: 'bash',
      input: { command: 'npm test' },
      execute: async () => {
        calls++
        if (calls === 1) return { content: 'Error: ETIMEDOUT', isError: true }
        return { content: 'ok' }
      },
      classify: (content) => content.includes('ETIMEDOUT') ? 'timeout' : undefined,
    })
    assert.equal(calls, 2)
    assert.equal(result.content, 'ok')
    assert.equal(result.isError, false)
    assert.equal(trajectory.getEntries().length, 1)
    assert.equal(trajectory.getEntries()[0]!.status, 'retried-success')
  })

  it('does not retry non-transient errors', async () => {
    const trajectory = new TrajectoryRecorder()
    const harness = new TurnHarness(makeConfig(), trajectory)
    let calls = 0
    const result = await harness.executeTool({
      id: 'tu3',
      name: 'edit_file',
      input: { file_path: 'x.ts' },
      execute: async () => { calls++; return { content: 'Type error TS2345', isError: true } },
      classify: () => 'type_error',
    })
    assert.equal(calls, 1)
    assert.equal(result.isError, true)
    assert.equal(trajectory.getEntries()[0]!.status, 'failed')
  })

  it('retries once then fails with reflexion hint', async () => {
    const trajectory = new TrajectoryRecorder()
    const harness = new TurnHarness(makeConfig(), trajectory)
    const result = await harness.executeTool({
      id: 'tu4',
      name: 'bash',
      input: { command: 'curl api' },
      execute: async () => ({ content: 'ECONNRESET', isError: true }),
      classify: () => 'timeout',
    })
    assert.equal(result.isError, true)
    assert.ok(result.content.includes('[Retry failed]'))
    assert.equal(trajectory.getEntries()[0]!.status, 'retried-failed')
  })

  it('calls onBeforeTool and onAfterTool hooks', async () => {
    const trajectory = new TrajectoryRecorder()
    const hooks: string[] = []
    const harness = new TurnHarness({
      ...makeConfig(),
      onBeforeTool: (name) => { hooks.push(`before:${name}`) },
      onAfterTool: (name, _r, isErr) => { hooks.push(`after:${name}:${isErr}`) },
    }, trajectory)
    await harness.executeTool({
      id: 'tu5',
      name: 'grep',
      input: { pattern: 'x' },
      execute: async () => ({ content: 'match' }),
      classify: () => undefined,
    })
    assert.deepEqual(hooks, ['before:grep', 'after:grep:false'])
  })
})
```

- [x] **步骤 2：运行测试验证失败**

运行：`npm test -- --test-path-pattern turn-harness.test 2>&1 | tail -5`
预期：FAIL，"Cannot find module '../turn-harness.js'"

- [x] **步骤 3：编写实现**

```typescript
// src/agent/turn-harness.ts
import { TrajectoryRecorder, type TrajectoryEntry } from './trajectory.js'
import { isTransient, type FailureClass } from './failure-classifier.js'

export interface ToolExecution {
  id: string
  name: string
  input: Record<string, unknown>
  execute: () => Promise<{ content: string; isError?: boolean }>
  classify: (content: string) => FailureClass | undefined
}

export interface ToolExecutionResult {
  content: string
  isError: boolean
  retried: boolean
  errorClass?: string
}

export interface TurnHarnessConfig {
  maxRetries: number
  retryableClasses: string[]
  onBeforeTool?: (name: string, input: Record<string, unknown>) => void
  onAfterTool?: (name: string, result: string, isError: boolean) => void
}

export class TurnHarness {
  constructor(
    private config: TurnHarnessConfig,
    private trajectory: TrajectoryRecorder,
  ) {}

  async executeTool(exec: ToolExecution): Promise<ToolExecutionResult> {
    this.config.onBeforeTool?.(exec.name, exec.input)
    const start = Date.now()

    let result = await exec.execute()
    let retried = false
    let errorClass: string | undefined

    if (result.isError) {
      errorClass = exec.classify(result.content) ?? undefined
      if (errorClass && isTransient(errorClass as FailureClass) && this.config.maxRetries > 0) {
        retried = true
        result = await exec.execute()
        if (result.isError) {
          result = { content: `${result.content}\n\n[Retry failed. Error class: ${errorClass}. This is a transient error — consider alternative approach.]`, isError: true }
        }
      }
    }

    const durationMs = Date.now() - start
    const status: TrajectoryEntry['status'] = retried
      ? (result.isError ? 'retried-failed' : 'retried-success')
      : (result.isError ? 'failed' : 'success')

    const target = typeof exec.input.file_path === 'string'
      ? exec.input.file_path
      : typeof exec.input.path === 'string'
        ? exec.input.path
        : typeof exec.input.command === 'string'
          ? exec.input.command.slice(0, 50)
          : exec.name

    this.trajectory.record({
      turn: 0,
      tool: exec.name,
      target,
      durationMs,
      status,
      errorClass: result.isError ? errorClass : undefined,
      inputSummary: JSON.stringify(exec.input).slice(0, 100),
      resultSummary: result.content.slice(0, 200),
    })

    this.config.onAfterTool?.(exec.name, result.content, result.isError ?? false)
    return { content: result.content, isError: result.isError ?? false, retried, errorClass }
  }
}
```

- [x] **步骤 4：运行测试验证通过**

运行：`npm test -- --test-path-pattern turn-harness.test 2>&1 | tail -5`
预期：PASS

- [x] **步骤 5：Commit**

```bash
git add src/agent/turn-harness.ts src/agent/__tests__/turn-harness.test.ts
git commit -m "feat(agent): add TurnHarness with retry and trajectory recording"
```

---

### 任务 4：loop.ts 集成 TurnHarness

**文件：**
- 修改：`src/agent/loop.ts:263-388`（用 TurnHarness 替代内联 tool 执行）

- [x] **步骤 1：在 loop.ts 中导入 TurnHarness 和 TrajectoryRecorder**

在文件顶部 import 区域追加：

```typescript
import { TurnHarness } from './turn-harness.js'
import { TrajectoryRecorder } from './trajectory.js'
import { classifyFailure, isTransient } from './failure-classifier.js'
```

在 `AgentLoop` 类的属性区域追加：

```typescript
private trajectory = new TrajectoryRecorder()
private harness: TurnHarness
```

在 constructor 末尾初始化 harness：

```typescript
this.harness = new TurnHarness(
  { maxRetries: 1, retryableClasses: ['timeout', 'flaky'] },
  this.trajectory,
)
```

- [x] **步骤 2：替换 tool 执行循环**

将 `loop.ts` 中 `for (const tu of toolUses) { ... }` 循环体（第 266-388 行）替换为使用 harness 的版本。保留 approval、checkpoint、prewarm、hooks 逻辑，但将实际执行委托给 harness：

```typescript
for (const tu of toolUses) {
  const params: ToolCallParams = {
    input: tu.input,
    toolUseId: tu.id,
    cwd: this.cwd,
    onOutput: (chunk) => { callbacks.onToolResult(tu.id, tu.name, chunk) },
  }
  try {
    // PreToolUse hook
    const preHookResult = this.config.hooks?.firePreToolUse({ toolName: tu.name, input: tu.input }) ?? {}
    if (preHookResult.block) {
      const blockMsg = `Tool blocked by hook: ${preHookResult.reason ?? 'no reason given'}`
      callbacks.onToolResult(tu.id, tu.name, blockMsg, true)
      toolResults.push({ type: 'tool_result', tool_use_id: tu.id, content: blockMsg, is_error: true })
      continue
    }
    if (preHookResult.input) { tu.input = preHookResult.input; params.input = preHookResult.input }

    // Approval check (unchanged)
    const needsApproval = this.config.toolRegistry.needsApproval(tu.name, params)
    const isHighRisk = needsApproval && this.isHighRisk(tu.name, tu.input)
    const approvalMode = this.config.approvalMode ?? 'manual'
    const shouldAsk = approvalMode === 'manual' ? needsApproval
      : approvalMode === 'auto-safe' ? isHighRisk : false
    if (shouldAsk) {
      const approved = await callbacks.onApprovalRequired(tu.id, tu.name, tu.input)
      if (!approved) {
        const denyMsg = 'Tool execution denied: requires user approval'
        callbacks.onToolResult(tu.id, tu.name, denyMsg, true)
        toolResults.push({ type: 'tool_result', tool_use_id: tu.id, content: denyMsg, is_error: true })
        continue
      }
    }

    // Checkpoint (unchanged)
    if ((tu.name === 'write_file' || tu.name === 'edit_file') && !checkpointCreatedThisTurn) {
      const cp = await createCheckpoint(this.cwd, 'auto')
      checkpointCreatedThisTurn = true
      if (cp) callbacks.onCheckpoint?.(cp.hash)
    }
    if ((tu.name === 'write_file' || tu.name === 'edit_file') && typeof tu.input.file_path === 'string') {
      recordAgentTouchedFile(this.cwd, tu.input.file_path)
    }

    // Execute via TurnHarness (NEW)
    const harnessResult = await this.harness.executeTool({
      id: tu.id,
      name: tu.name,
      input: tu.input,
      execute: async () => {
        if (tu.name === 'read_file' && typeof tu.input.file_path === 'string') {
          const cached = this.prewarm.get(tu.input.file_path)
          if (cached) return { content: cached }
        }
        const r = await this.config.toolRegistry.execute(tu.name, params)
        return { content: r.content, isError: r.isError }
      },
      classify: (content) => classifyFailure(content).class,
    })

    // PostToolUse hook
    const postHookResult = this.config.hooks?.firePostToolUse({
      toolName: tu.name,
      input: tu.input,
      result: harnessResult.content,
      isError: harnessResult.isError,
    }) ?? {}
    const finalContent = postHookResult.result ?? harnessResult.content

    callbacks.onToolResult(tu.id, tu.name, finalContent, harnessResult.isError)
    this.recordToolHistory(tu.name, tu.input, harnessResult.isError, harnessResult.content)

    // Prewarm invalidation + evidence tracking (unchanged)
    if ((tu.name === 'write_file' || tu.name === 'edit_file') && !harnessResult.isError && typeof tu.input.file_path === 'string') {
      this.prewarm.invalidate(tu.input.file_path)
    }
    if (tu.name === 'read_file' && !harnessResult.isError) {
      this.evidence.trackFileRead(tu.input.file_path as string)
    } else if ((tu.name === 'write_file' || tu.name === 'edit_file') && !harnessResult.isError) {
      this.evidence.trackFileModified(tu.input.file_path as string)
    } else if (tu.name === 'run_tests' && !harnessResult.isError) {
      // verification tracking stays the same
    }

    toolResults.push({
      type: 'tool_result',
      tool_use_id: tu.id,
      content: finalContent,
      is_error: harnessResult.isError,
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    callbacks.onToolResult(tu.id, tu.name, msg, true)
    toolResults.push({ type: 'tool_result', tool_use_id: tu.id, content: msg, is_error: true })
  }
}
```

- [x] **步骤 3：运行全量测试**

运行：`npm test 2>&1 | tail -10`
预期：355 tests pass（行为不变，只是执行路径经过 harness）

- [x] **步骤 4：运行 typecheck**

运行：`npm run typecheck`
预期：clean

- [x] **步骤 5：Commit**

```bash
git add src/agent/loop.ts
git commit -m "refactor(agent): integrate TurnHarness into agent loop for tool execution"
```

---

### 任务 5：Task State Extractor + Volatile Context 注入

**文件：**
- 创建：`src/agent/task-state.ts`
- 创建：`src/agent/__tests__/task-state.test.ts`
- 修改：`src/prompt/volatile.ts`（新增 `<task-progress>` section）

- [x] **步骤 1：编写失败的测试**

```typescript
// src/agent/__tests__/task-state.test.ts
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { extractTaskState } from '../task-state.js'
import type { TrajectoryEntry } from '../trajectory.js'

describe('extractTaskState', () => {
  it('extracts completed steps from trajectory', () => {
    const entries: TrajectoryEntry[] = [
      { turn: 1, tool: 'read_file', target: 'src/auth.ts', durationMs: 30, status: 'success', inputSummary: '', resultSummary: '' },
      { turn: 1, tool: 'edit_file', target: 'src/auth.ts', durationMs: 50, status: 'success', inputSummary: '', resultSummary: '' },
      { turn: 2, tool: 'bash', target: 'npm test', durationMs: 200, status: 'failed', errorClass: 'assertion', inputSummary: '', resultSummary: '' },
    ]
    const state = extractTaskState(entries, '')
    assert.equal(state.completed.length, 2)
    assert.ok(state.completed[0]!.includes('read_file'))
    assert.ok(state.completed[1]!.includes('edit_file'))
    assert.ok(state.current.includes('fixing'))
  })

  it('extracts remaining from model text', () => {
    const entries: TrajectoryEntry[] = [
      { turn: 1, tool: 'read_file', target: 'a.ts', durationMs: 10, status: 'success', inputSummary: '', resultSummary: '' },
    ]
    const text = 'Next I need to edit the middleware and then run the tests.'
    const state = extractTaskState(entries, text)
    assert.ok(state.remaining.length > 0)
  })

  it('limits completed to last 5 entries', () => {
    const entries: TrajectoryEntry[] = Array.from({ length: 8 }, (_, i) => ({
      turn: 1, tool: 'read_file', target: `file${i}.ts`, durationMs: 10, status: 'success' as const, inputSummary: '', resultSummary: '',
    }))
    const state = extractTaskState(entries, '')
    assert.equal(state.completed.length, 5)
  })

  it('returns empty state for no entries', () => {
    const state = extractTaskState([], '')
    assert.equal(state.completed.length, 0)
    assert.equal(state.current, 'starting')
  })
})
```

- [x] **步骤 2：运行测试验证失败**

运行：`npm test -- --test-path-pattern task-state.test 2>&1 | tail -5`
预期：FAIL，"Cannot find module '../task-state.js'"

- [x] **步骤 3：编写 task-state.ts 实现**

```typescript
// src/agent/task-state.ts
import type { TrajectoryEntry } from './trajectory.js'

export interface TaskState {
  completed: string[]
  current: string
  remaining: string[]
}

const NEXT_STEP_RE = /(?:next|then|after that|接下来|然后)[^.。]*(?:[.。]|$)/gi

export function extractTaskState(entries: TrajectoryEntry[], lastModelText: string): TaskState {
  if (entries.length === 0) return { completed: [], current: 'starting', remaining: [] }

  const successful = entries.filter(e => e.status === 'success' || e.status === 'retried-success')
  const completed = successful.slice(-5).map(e => `${e.tool} ${e.target.split('/').pop() ?? e.target}`)

  const lastEntry = entries[entries.length - 1]!
  const current = lastEntry.status === 'failed' || lastEntry.status === 'retried-failed'
    ? `fixing ${lastEntry.errorClass ?? 'error'} in ${lastEntry.target.split('/').pop()}`
    : `${lastEntry.tool} ${lastEntry.target.split('/').pop()}`

  const remaining: string[] = []
  for (const match of lastModelText.matchAll(NEXT_STEP_RE)) {
    remaining.push(match[0].trim().slice(0, 60))
    if (remaining.length >= 3) break
  }

  return { completed, current, remaining }
}
```

- [x] **步骤 4：运行测试验证通过**

运行：`npm test -- --test-path-pattern task-state.test 2>&1 | tail -5`
预期：PASS

- [x] **步骤 5：修改 volatile.ts 添加 task-progress section**

在 `src/prompt/volatile.ts` 的 `VolatileContext` 接口中新增字段：

```typescript
import type { TaskState } from '../agent/task-state.js'

// 在 VolatileContext 接口中追加：
taskProgress?: TaskState
```

在 `buildVolatileBlock` 函数中，在 `sessionMemoryBlock` 之前插入：

```typescript
if (ctx.taskProgress && ctx.taskProgress.completed.length > 0) {
  const done = ctx.taskProgress.completed.map(s => `    <done>${escapeXml(s)}</done>`).join('\n')
  const remaining = ctx.taskProgress.remaining.length > 0
    ? '\n' + ctx.taskProgress.remaining.map(s => `    <next>${escapeXml(s)}</next>`).join('\n')
    : ''
  parts.push(`<task-progress steps="${ctx.taskProgress.completed.length}" current="${escapeXml(ctx.taskProgress.current)}">\n${done}${remaining}\n  </task-progress>`)
}
```

- [x] **步骤 6：运行全量测试**

运行：`npm test 2>&1 | tail -5`
预期：all pass

- [x] **步骤 7：Commit**

```bash
git add src/agent/task-state.ts src/agent/__tests__/task-state.test.ts src/prompt/volatile.ts
git commit -m "feat(agent): add task-state extraction and volatile context injection"
```

---

### 任务 6：loop.ts 注入 task-progress 到 volatile context

**文件：**
- 修改：`src/agent/loop.ts`（在 turn 结束时提取 task-state 并传给 promptEngine）

- [x] **步骤 1：在 loop.ts 的 run() 方法中，tool 执行完成后提取 task-state**

在 `this.session.addToolResults(toolResults)` 之后、`this.refreshLedger()` 之前插入：

```typescript
// Inject task-progress into volatile context (only after turn 3)
if (this.session.getTurnCount() > 3) {
  const taskState = extractTaskState(this.trajectory.getEntries(), this.streamedText)
  this.config.promptEngine.setTaskProgress(taskState)
}
```

- [x] **步骤 2：在 PromptEngine 中添加 setTaskProgress 方法**

在 `src/prompt/engine.ts` 的 `PromptEngine` 类中追加：

```typescript
import type { TaskState } from '../agent/task-state.js'

// 在类中追加属性和方法：
private taskProgress?: TaskState

setTaskProgress(state: TaskState): void {
  this.taskProgress = state
}
```

修改 `buildRequest` 方法中构建 fresh volatile block 的部分：

```typescript
// 原来：
const freshBlock = buildVolatileBlock({ ...this.config.volatileCtx, toolHistory })
// 改为：
const freshBlock = buildVolatileBlock({ ...this.config.volatileCtx, toolHistory, taskProgress: this.taskProgress })
```

- [x] **步骤 3：在 loop.ts 顶部添加 import**

```typescript
import { extractTaskState } from './task-state.js'
```

- [x] **步骤 4：运行全量测试 + typecheck**

运行：`npm test 2>&1 | tail -5 && npm run typecheck`
预期：all pass, typecheck clean

- [x] **步骤 5：Commit**

```bash
git add src/agent/loop.ts src/prompt/engine.ts
git commit -m "feat(agent): wire task-state into volatile context for implicit planning"
```

---

### 任务 7：Trajectory 暴露给 SummaryBar + 清理

**文件：**
- 修改：`src/agent/loop.ts`（暴露 trajectory stats）
- 修改：`src/tui/app.tsx`（SummaryBar 消费 trajectory stats）

- [x] **步骤 1：在 AgentLoop 中暴露 trajectory 统计**

在 `AgentLoop` 类中追加公开方法：

```typescript
getTrajectoryStats(): { totalTools: number; failures: number; retries: number; avgDurationMs: number } {
  return this.trajectory.summarize()
}

resetTrajectory(): void {
  this.trajectory.reset()
}
```

在 `run()` 方法的 `break`（turn 完成退出循环）之前调用 reset：

```typescript
// 在 break 之前不 reset — trajectory 保留整个 run 的记录
// 在 run() 方法开头 reset（新一轮 user input 开始时）
```

实际上在 `run()` 方法开头（`this.abortController = new AbortController()` 之后）追加：

```typescript
this.trajectory.reset()
```

- [x] **步骤 2：在 app.tsx 中消费 trajectory stats**

在 SummaryBar 的 state 构建中，将 `stepCount` 改为从 trajectory 获取：

```typescript
// 在构建 SummaryState 时：
stepCount: agentLoop.getTrajectoryStats().totalTools,
```

（具体位置取决于 app.tsx 中 SummaryState 的构建方式——查找 `stepCount` 赋值处替换）

- [x] **步骤 3：运行全量测试 + typecheck**

运行：`npm test 2>&1 | tail -5 && npm run typecheck`
预期：all pass

- [x] **步骤 4：Commit**

```bash
git add src/agent/loop.ts src/tui/app.tsx
git commit -m "feat(tui): wire trajectory stats into SummaryBar step count"
```

---

## 自检

### 1. 规格覆盖度

| 设计规格要求 | 对应任务 |
|-------------|---------|
| TurnHarness 封装 tool 执行 | 任务 3 + 任务 4 |
| Tool retry for transient errors | 任务 2 + 任务 3 |
| Trajectory recording | 任务 1 |
| Task-state extraction | 任务 5 |
| Volatile context `<task-progress>` injection | 任务 5 + 任务 6 |
| SummaryBar 消费 trajectory | 任务 7 |
| loop.ts 减负 | 任务 4（执行逻辑委托给 harness） |
| Harness hooks (onBeforeTool/onAfterTool) | 任务 3 |
| Reflexion hint on retry failure | 任务 3（`[Retry failed...]` 注入） |

### 2. 占位符扫描

无 TODO、待定、"后续实现"。

### 3. 类型一致性

- `TrajectoryEntry` 在任务 1 定义，任务 3/5/7 消费 — 字段名一致
- `TurnHarnessConfig` 在任务 3 定义，任务 4 消费 — 接口一致
- `TaskState` 在任务 5 定义，任务 6 消费 — 字段名一致
- `isTransient` 在任务 2 定义，任务 3 消费 — 签名一致
- `ToolExecution.classify` 返回 `FailureClass | undefined`，与 `classifyFailure().class` 类型一致

### 4. 依赖顺序

```
任务 1 (TrajectoryRecorder) ← 任务 3 (TurnHarness) ← 任务 4 (loop.ts 集成)
任务 2 (isTransient)        ← 任务 3 (TurnHarness)
任务 5 (TaskState + volatile) ← 任务 6 (loop.ts 注入)
任务 7 (SummaryBar) 依赖任务 4
```

任务 1 和 2 可并行。任务 5 可与任务 3/4 并行。任务 7 最后执行。