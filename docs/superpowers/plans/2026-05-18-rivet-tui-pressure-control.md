# Rivet TUI Pressure Control 实施计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 给 Rivet 增加 measurement-first 的多域压力控制基础，让长会话、流式输出、大工具结果和多 worker 委托在不污染 DeepSeek 稳定前缀的前提下保持可观测、可降级、可恢复。

**架构：** 新增 `src/pressure/*` 作为 runtime pressure 观测层，复用但不替代已有 `src/context/pressure-monitor.ts`。第一阶段只采样并回调，不改变执行行为；第二阶段引入 priority lanes 和 bounded queue；第三阶段引入 metadata-only ghost manifest；第四阶段只把 pressure samples 喂给 Sensorium/Stigmergy，不让它们直接发命令。

**技术栈：** TypeScript, Node.js `node:test`, Ink 6, existing AgentLoop callbacks, existing `RenderBatcher`, `WorkOrderQueue`, `compact-policy`, `tool-pipeline` rawPath support.

---

## 前置约束

- 当前工作区已有与本计划无关的未提交改动：`src/agent/loop.ts`、`src/agent/star-event.ts`、`src/agent/__tests__/star-event.test.ts`。执行本计划前必须先让用户决定：提交、暂存到 worktree/stash、或明确把这些改动纳入同一实现批次。
- 不修改 provider request prefix、system prompt、tool definitions 的稳定顺序或内容。Pressure telemetry 只进入本地 recorder、UI log、测试 harness，不能进入模型上下文前缀。
- Phase 1 不改变行为：不降并发、不溢写新内容、不改变 compaction 决策，只发 `onPressureSample` 回调和本地记录。
- `abort`、approval、steer 属于 control plane，后续任何队列化都必须允许 control lane 旁路。
- 项目使用 `node:test` + `node:assert/strict`，不要引入 Vitest/Jest。

---

## 文件结构

### 新建文件

| 文件 | 职责 |
|------|------|
| `src/pressure/types.ts` | 多域 pressure 的共享类型、level/action 枚举、sample/recommendation/summary 类型。 |
| `src/pressure/recorder.ts` | 有界内存 recorder：保存最近 N 条 sample，按 domain 查询 latest/summary。 |
| `src/pressure/context-sample.ts` | 从 estimated tokens、context window、compact decision 生成 context pressure sample。 |
| `src/pressure/stream-sample.ts` | 从 streamed text、content blocks、tool result length/rawPath 生成 stream pressure sample。 |
| `src/pressure/bounded-lane.ts` | Phase 2 的 priority lane queue；control lane 旁路 capacity。 |
| `src/pressure/ghost-manifest.ts` | Phase 3 的 metadata-only ghost manifest，保存 evicted/spilled 对象元数据。 |
| `src/pressure/__tests__/recorder.test.ts` | recorder 有界、latest、summary 测试。 |
| `src/pressure/__tests__/context-sample.test.ts` | context sample level/recommendation 测试。 |
| `src/pressure/__tests__/stream-sample.test.ts` | stream/tool-result sample 测试。 |
| `src/pressure/__tests__/bounded-lane.test.ts` | control lane 旁路、background capacity、FIFO/priority 测试。 |
| `src/pressure/__tests__/ghost-manifest.test.ts` | metadata-only、touch、LRU 截断测试。 |

### 修改文件

| 文件 | 变更 |
|------|------|
| `src/tui/render-batch.ts:5-41` | 增加可选 measurement callback，flush 时报告 pending/flush latency/item count。 |
| `src/tui/__tests__/render-batch.test.ts:9-53` | 增加 sampling 不改变 batching 行为的测试。 |
| `src/agent/loop.ts:80-93` | `AgentCallbacks` 增加 optional `onPressureSample`。 |
| `src/agent/loop.ts:432-440` | compaction decision 后发 context pressure sample。 |
| `src/agent/loop.ts:583-588` | stream 完成后发 streamed text/content/tool-use sample。 |
| `src/agent/tool-pipeline.ts:93-109,288-304,413` | 工具执行结束时发 tool-result pressure sample；不改变返回 content。 |
| `src/agent/__tests__/tool-pipeline.test.ts:45-55` | 覆盖 tool-result sample 与 rawPath metadata。 |
| `src/agent/work-queue.ts:8-63` | 增加 `snapshot()`，只读 pending/inFlight/maxConcurrency/dependencyBlocked。 |
| `src/agent/__tests__/work-queue.test.ts:19-96` | 覆盖 snapshot。 |
| `src/agent/coordinator.ts:51-58,171-237` | config 增加 optional `onPressureSample`，delegateBatch 中记录 workQueue sample。 |
| `src/agent/__tests__/coordinator.test.ts:165-260` | 覆盖 batch worker pressure samples。 |
| `src/tui/app.tsx:235-243,590-612,673-755,759-815` | Phase 1 接收 samples 到 local recorder；不展示、不改变行为。 |
| `src/agent/sensorium.ts` | Phase 4 增加 pressure sample adapter 输入，不改变现有 compute 语义。 |
| `src/agent/__tests__/sensorium.test.ts` | Phase 4 覆盖 pressure samples 只影响 pressure/stability 输入。 |

---

## Phase 0：执行前卫生检查

### 任务 0：隔离当前未提交改动

**文件：**
- 检查：`src/agent/loop.ts`
- 检查：`src/agent/star-event.ts`
- 检查：`src/agent/__tests__/star-event.test.ts`

- [ ] **步骤 1：查看工作区状态**

运行：

```bash
git status --short
```

预期：如果出现以下改动，先暂停实现并让用户决定处理方式：

```text
 M src/agent/loop.ts
 M src/agent/star-event.ts
 M src/agent/__tests__/star-event.test.ts
```

- [ ] **步骤 2：确认这些改动是否属于当前 pressure-control 范围**

判断规则：

```text
属于当前范围：只包含 pressure sample callback、measurement-only wiring、pressure tests。
不属于当前范围：star-event/dissipative-kick 行为变化、strategy tuning、模型提示变化。
```

预期：如果不属于当前范围，不要混进 pressure-control commit。

- [ ] **步骤 3：运行当前基线测试**

运行：

```bash
npm run typecheck
npm test -- src/tui/__tests__/render-batch.test.ts src/agent/__tests__/work-queue.test.ts src/agent/__tests__/coordinator.test.ts src/agent/__tests__/tool-pipeline.test.ts
```

预期：PASS。若失败，先修复基线或退出本计划。

---

## Phase 1：measurement-only baseline

### 任务 1：新增 pressure types + recorder

**文件：**
- 创建：`src/pressure/types.ts`
- 创建：`src/pressure/recorder.ts`
- 创建：`src/pressure/__tests__/recorder.test.ts`

- [ ] **步骤 1：编写失败测试**

```typescript
// src/pressure/__tests__/recorder.test.ts
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { PressureRecorder } from '../recorder.js'
import type { PressureSample } from '../types.js'

function sample(domain: PressureSample['domain'], measuredAt: number, value: number): PressureSample {
  return {
    domain,
    level: value >= 0.9 ? 'full' : value >= 0.7 ? 'some' : 'normal',
    measuredAt,
    metrics: { value },
  }
}

describe('PressureRecorder', () => {
  it('keeps samples bounded and preserves newest samples', () => {
    const recorder = new PressureRecorder(3)
    recorder.record(sample('render', 1, 0.1))
    recorder.record(sample('stream', 2, 0.2))
    recorder.record(sample('context', 3, 0.3))
    recorder.record(sample('workQueue', 4, 0.4))

    assert.deepEqual(recorder.getSamples().map(s => s.measuredAt), [2, 3, 4])
  })

  it('returns the latest sample by domain', () => {
    const recorder = new PressureRecorder(10)
    recorder.record(sample('render', 1, 0.1))
    recorder.record(sample('context', 2, 0.8))
    recorder.record(sample('render', 3, 0.9))

    assert.equal(recorder.latest('render')?.measuredAt, 3)
    assert.equal(recorder.latest('context')?.level, 'some')
    assert.equal(recorder.latest('lifecycle'), undefined)
  })

  it('summarizes counts by domain and level', () => {
    const recorder = new PressureRecorder(10)
    recorder.record(sample('render', 1, 0.1))
    recorder.record(sample('render', 2, 0.8))
    recorder.record(sample('stream', 3, 0.95))

    assert.deepEqual(recorder.summary(), {
      total: 3,
      byDomain: { render: 2, stream: 1, workQueue: 0, context: 0, lifecycle: 0 },
      byLevel: { normal: 1, some: 1, full: 1 },
    })
  })
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：

```bash
npm test -- src/pressure/__tests__/recorder.test.ts
```

预期：FAIL，模块 `../recorder.js` 不存在。

- [ ] **步骤 3：实现共享类型**

```typescript
// src/pressure/types.ts
export type PressureDomain = 'render' | 'stream' | 'workQueue' | 'context' | 'lifecycle'
export type PressureLevel = 'normal' | 'some' | 'full'
export type PressureAction = 'observe' | 'coalesce' | 'spill' | 'pause' | 'compact' | 'checkpoint' | 'fail_fast'
export type PressurePriority = 'control' | 'interactive' | 'background'

export interface PressureRecommendation {
  action: PressureAction
  visibleMessage: string
  priority: PressurePriority
}

export interface PressureSample {
  domain: PressureDomain
  level: PressureLevel
  measuredAt: number
  metrics: Record<string, number>
  recommendation?: PressureRecommendation
}

export interface PressureSummary {
  total: number
  byDomain: Record<PressureDomain, number>
  byLevel: Record<PressureLevel, number>
}
```

- [ ] **步骤 4：实现 recorder**

```typescript
// src/pressure/recorder.ts
import type { PressureDomain, PressureLevel, PressureSample, PressureSummary } from './types.js'

const DOMAINS: PressureDomain[] = ['render', 'stream', 'workQueue', 'context', 'lifecycle']
const LEVELS: PressureLevel[] = ['normal', 'some', 'full']

export class PressureRecorder {
  private samples: PressureSample[] = []

  constructor(private readonly capacity = 200) {}

  record(sample: PressureSample): void {
    this.samples = [...this.samples, sample].slice(-this.capacity)
  }

  getSamples(domain?: PressureDomain): PressureSample[] {
    const selected = domain === undefined
      ? this.samples
      : this.samples.filter(sample => sample.domain === domain)
    return [...selected]
  }

  latest(domain: PressureDomain): PressureSample | undefined {
    for (let i = this.samples.length - 1; i >= 0; i--) {
      const sample = this.samples[i]
      if (sample?.domain === domain) return sample
    }
    return undefined
  }

  summary(): PressureSummary {
    const byDomain = Object.fromEntries(DOMAINS.map(domain => [domain, 0])) as Record<PressureDomain, number>
    const byLevel = Object.fromEntries(LEVELS.map(level => [level, 0])) as Record<PressureLevel, number>

    for (const sample of this.samples) {
      byDomain[sample.domain]++
      byLevel[sample.level]++
    }

    return { total: this.samples.length, byDomain, byLevel }
  }
}
```

- [ ] **步骤 5：运行测试验证通过**

运行：

```bash
npm test -- src/pressure/__tests__/recorder.test.ts
```

预期：PASS。

- [ ] **步骤 6：Commit**

```bash
git add src/pressure/types.ts src/pressure/recorder.ts src/pressure/__tests__/recorder.test.ts
git commit -m "feat(pressure): add runtime pressure recorder"
```

---

### 任务 2：新增 context/stream sample helpers

**文件：**
- 创建：`src/pressure/context-sample.ts`
- 创建：`src/pressure/stream-sample.ts`
- 创建：`src/pressure/__tests__/context-sample.test.ts`
- 创建：`src/pressure/__tests__/stream-sample.test.ts`

- [ ] **步骤 1：编写 context sample 失败测试**

```typescript
// src/pressure/__tests__/context-sample.test.ts
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createContextPressureSample } from '../context-sample.js'

describe('createContextPressureSample', () => {
  it('classifies context pressure from token ratio', () => {
    assert.equal(createContextPressureSample({ estimatedTokens: 5000, contextWindow: 10_000, turn: 1 }).level, 'normal')
    assert.equal(createContextPressureSample({ estimatedTokens: 8000, contextWindow: 10_000, turn: 1 }).level, 'some')
    assert.equal(createContextPressureSample({ estimatedTokens: 9600, contextWindow: 10_000, turn: 1 }).level, 'full')
  })

  it('recommends compact only at full context pressure', () => {
    const sample = createContextPressureSample({ estimatedTokens: 9600, contextWindow: 10_000, turn: 3 })
    assert.equal(sample.domain, 'context')
    assert.equal(sample.recommendation?.action, 'checkpoint')
    assert.match(sample.recommendation?.visibleMessage ?? '', /context pressure/i)
    assert.equal(sample.metrics.ratio, 0.96)
  })
})
```

- [ ] **步骤 2：编写 stream sample 失败测试**

```typescript
// src/pressure/__tests__/stream-sample.test.ts
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createStreamPressureSample, createToolResultPressureSample } from '../stream-sample.js'

describe('stream pressure samples', () => {
  it('records streamed text and block counts without retaining content', () => {
    const sample = createStreamPressureSample({ streamedChars: 12_000, contentBlocks: 3, toolUses: 2, turn: 4 })

    assert.equal(sample.domain, 'stream')
    assert.equal(sample.metrics.streamedChars, 12_000)
    assert.equal(sample.metrics.contentBlocks, 3)
    assert.equal(sample.metrics.toolUses, 2)
    assert.equal(Object.values(sample.metrics).includes(Number.NaN), false)
  })

  it('records rawPath presence for large tool results without storing the result body', () => {
    const sample = createToolResultPressureSample({ toolName: 'read_file', resultChars: 120_000, hasRawPath: true, isError: false })

    assert.equal(sample.level, 'full')
    assert.equal(sample.metrics.resultChars, 120_000)
    assert.equal(sample.metrics.hasRawPath, 1)
    assert.equal(sample.recommendation?.action, 'spill')
  })
})
```

- [ ] **步骤 3：运行测试验证失败**

运行：

```bash
npm test -- src/pressure/__tests__/context-sample.test.ts src/pressure/__tests__/stream-sample.test.ts
```

预期：FAIL，helper 模块不存在。

- [ ] **步骤 4：实现 context sample helper**

```typescript
// src/pressure/context-sample.ts
import type { PressureSample } from './types.js'

export interface ContextPressureInput {
  estimatedTokens: number
  contextWindow: number
  turn: number
}

export function createContextPressureSample(input: ContextPressureInput): PressureSample {
  const ratio = input.contextWindow > 0 ? input.estimatedTokens / input.contextWindow : 1
  const level = ratio >= 0.95 ? 'full' : ratio >= 0.78 ? 'some' : 'normal'

  return {
    domain: 'context',
    level,
    measuredAt: Date.now(),
    metrics: {
      estimatedTokens: input.estimatedTokens,
      contextWindow: input.contextWindow,
      ratio,
      turn: input.turn,
    },
    recommendation: level === 'full'
      ? {
          action: 'checkpoint',
          priority: 'background',
          visibleMessage: `Context pressure ${(ratio * 100).toFixed(1)}%; checkpoint-resume may be required`,
        }
      : undefined,
  }
}
```

- [ ] **步骤 5：实现 stream sample helper**

```typescript
// src/pressure/stream-sample.ts
import type { PressureSample } from './types.js'

export interface StreamPressureInput {
  streamedChars: number
  contentBlocks: number
  toolUses: number
  turn: number
}

export interface ToolResultPressureInput {
  toolName: string
  resultChars: number
  hasRawPath: boolean
  isError: boolean
}

export function createStreamPressureSample(input: StreamPressureInput): PressureSample {
  const level = input.streamedChars >= 80_000 ? 'full' : input.streamedChars >= 20_000 ? 'some' : 'normal'
  return {
    domain: 'stream',
    level,
    measuredAt: Date.now(),
    metrics: {
      streamedChars: input.streamedChars,
      contentBlocks: input.contentBlocks,
      toolUses: input.toolUses,
      turn: input.turn,
    },
  }
}

export function createToolResultPressureSample(input: ToolResultPressureInput): PressureSample {
  const level = input.resultChars >= 100_000 ? 'full' : input.resultChars >= 24_000 ? 'some' : 'normal'
  return {
    domain: 'stream',
    level,
    measuredAt: Date.now(),
    metrics: {
      resultChars: input.resultChars,
      hasRawPath: input.hasRawPath ? 1 : 0,
      isError: input.isError ? 1 : 0,
    },
    recommendation: level === 'full'
      ? {
          action: 'spill',
          priority: 'background',
          visibleMessage: `${input.toolName} produced ${input.resultChars} chars; prefer rawPath/preview retention`,
        }
      : undefined,
  }
}
```

- [ ] **步骤 6：运行测试验证通过**

运行：

```bash
npm test -- src/pressure/__tests__/context-sample.test.ts src/pressure/__tests__/stream-sample.test.ts
```

预期：PASS。

- [ ] **步骤 7：Commit**

```bash
git add src/pressure/context-sample.ts src/pressure/stream-sample.ts src/pressure/__tests__/context-sample.test.ts src/pressure/__tests__/stream-sample.test.ts
git commit -m "feat(pressure): add context and stream sample helpers"
```

---

### 任务 3：RenderBatcher measurement callback

**文件：**
- 修改：`src/tui/render-batch.ts:5-41`
- 修改：`src/tui/__tests__/render-batch.test.ts:9-53`

- [ ] **步骤 1：编写失败测试**

追加到 `src/tui/__tests__/render-batch.test.ts`：

```typescript
it('reports flush samples without changing batch semantics', async () => {
  const flushed: string[][] = []
  const samples: Array<{ itemCount: number; pendingBeforeFlush: number; flushLatencyMs: number; flushedBy: string }> = []
  let now = 100
  const batcher = new RenderBatcher<string>(
    (items) => flushed.push(items),
    {
      now: () => now,
      onFlushSample: (sample) => samples.push(sample),
    },
  )

  batcher.push('a')
  batcher.push('b')
  now = 116
  await drainMicrotasks()

  assert.deepEqual(flushed, [['a', 'b']])
  assert.equal(samples.length, 1)
  assert.equal(samples[0]!.itemCount, 2)
  assert.equal(samples[0]!.pendingBeforeFlush, 2)
  assert.equal(samples[0]!.flushLatencyMs, 16)
  assert.equal(samples[0]!.flushedBy, 'microtask')
})

it('reports flushNow samples separately from microtask flushes', async () => {
  const samples: Array<{ flushedBy: string }> = []
  const batcher = new RenderBatcher<string>(() => {}, { onFlushSample: sample => samples.push(sample) })

  batcher.push('a')
  batcher.flushNow()
  await drainMicrotasks()

  assert.deepEqual(samples.map(s => s.flushedBy), ['sync'])
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：

```bash
npm test -- src/tui/__tests__/render-batch.test.ts
```

预期：FAIL，`RenderBatcher` 构造函数不接受第二个参数。

- [ ] **步骤 3：修改 RenderBatcher**

```typescript
// src/tui/render-batch.ts
export type FlushFn<T> = (items: T[]) => void

export interface RenderBatchSample {
  itemCount: number
  pendingBeforeFlush: number
  flushLatencyMs: number
  flushedBy: 'microtask' | 'sync'
}

export interface RenderBatcherOptions {
  now?: () => number
  onFlushSample?: (sample: RenderBatchSample) => void
}

export class RenderBatcher<T> {
  private queue: T[] = []
  private scheduled = false
  private scheduledAt = 0
  private now: () => number

  constructor(
    private flush: FlushFn<T>,
    private options: RenderBatcherOptions = {},
  ) {
    this.now = options.now ?? Date.now
  }

  push(item: T): void {
    this.queue.push(item)
    if (!this.scheduled) {
      this.scheduled = true
      this.scheduledAt = this.now()
      queueMicrotask(() => {
        this.scheduled = false
        this.flushQueued('microtask')
      })
    }
  }

  flushNow(): void {
    this.scheduled = false
    this.flushQueued('sync')
  }

  private flushQueued(flushedBy: 'microtask' | 'sync'): void {
    const items = this.queue
    this.queue = []
    if (items.length > 0) {
      this.flush(items)
      this.options.onFlushSample?.({
        itemCount: items.length,
        pendingBeforeFlush: items.length,
        flushLatencyMs: Math.max(0, this.now() - this.scheduledAt),
        flushedBy,
      })
    }
  }

  get pending(): number {
    return this.queue.length
  }
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：

```bash
npm test -- src/tui/__tests__/render-batch.test.ts
```

预期：PASS。

- [ ] **步骤 5：Commit**

```bash
git add src/tui/render-batch.ts src/tui/__tests__/render-batch.test.ts
git commit -m "feat(tui): sample render batch pressure"
```

---

### 任务 4：AgentLoop context/stream pressure callback

**文件：**
- 修改：`src/agent/loop.ts:80-93`
- 修改：`src/agent/loop.ts:432-440`
- 修改：`src/agent/loop.ts:583-588`
- 修改：`src/agent/__tests__/loop.test.ts`

- [ ] **步骤 1：编写失败测试**

在 `src/agent/__tests__/loop.test.ts` imports 中加入：

```typescript
import type { PressureSample } from '../../pressure/types.js'
```

该文件当前已有 `makeCallbacks()`、`makeTextBlock()`、`makeEngine()` helper。追加测试：

```typescript
it('emits measurement-only context and stream pressure samples without adding session messages', async () => {
  const session = new SessionContext()
  const registry = new ToolRegistry()
  const samples: PressureSample[] = []

  const client: ApiClient = {
    stream: mock.fn(async (_req: unknown, cb: StreamCallbacks) => {
      cb.onTextDelta('hello pressure')
      cb.onContentBlock(makeTextBlock('hello pressure'))
      cb.onStopReason('end_turn', { input_tokens: 100, output_tokens: 20 })
    }),
  } as unknown as ApiClient

  const agent = new AgentLoop(
    {
      client,
      promptEngine: makeEngine(),
      toolRegistry: registry,
      maxTurns: 2,
      contextWindow: 1_000_000,
      compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' },
    },
    session,
    '/test',
  )

  await agent.run('say hello', {
    ...makeCallbacks(),
    onPressureSample: sample => samples.push(sample),
  })

  assert.ok(samples.some(s => s.domain === 'context'))
  assert.ok(samples.some(s => s.domain === 'stream'))
  assert.equal(session.getMessages().some(m => JSON.stringify(m).includes('PressureSample')), false)
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：

```bash
npm test -- src/agent/__tests__/loop.test.ts
```

预期：FAIL，`onPressureSample` 类型不存在或没有 sample。

- [ ] **步骤 3：扩展 AgentCallbacks 类型**

在 `src/agent/loop.ts:1-52` 增加 import：

```typescript
import type { PressureSample } from '../pressure/types.js'
import { createContextPressureSample } from '../pressure/context-sample.js'
import { createStreamPressureSample } from '../pressure/stream-sample.js'
```

在 `AgentCallbacks` 末尾增加：

```typescript
onPressureSample?: (sample: PressureSample) => void
```

- [ ] **步骤 4：在 context decision 后发 sample**

在 `src/agent/loop.ts:432-440` 的 `compactDecision` 创建后立刻加入：

```typescript
callbacks.onPressureSample?.(createContextPressureSample({
  estimatedTokens: estTokens,
  contextWindow: this.config.contextWindow,
  turn: this.session.getTurnCount(),
}))
```

- [ ] **步骤 5：在 stream 完成后发 sample**

在 `src/agent/loop.ts:583-588` 后加入：

```typescript
callbacks.onPressureSample?.(createStreamPressureSample({
  streamedChars: this.streamedText.length,
  contentBlocks: collectedBlocks.length,
  toolUses: toolUses.length,
  turn: this.session.getTurnCount(),
}))
```

- [ ] **步骤 6：运行测试验证通过**

运行：

```bash
npm test -- src/agent/__tests__/loop.test.ts
npm run typecheck
```

预期：PASS。

- [ ] **步骤 7：Commit**

```bash
git add src/agent/loop.ts src/agent/__tests__/loop.test.ts
git commit -m "feat(agent): emit measurement-only pressure samples"
```

---

### 任务 5：Tool pipeline 发 tool-result pressure sample

**文件：**
- 修改：`src/agent/tool-pipeline.ts:70-78`
- 修改：`src/agent/tool-pipeline.ts:288-304`
- 修改：`src/agent/tool-pipeline.ts:413`
- 修改：`src/agent/__tests__/tool-pipeline.test.ts:45-55`

- [ ] **步骤 1：编写失败测试**

在 `src/agent/__tests__/tool-pipeline.test.ts` imports 中加入：

```typescript
import type { PressureSample } from '../../pressure/types.js'
```

追加测试：

```typescript
it('emits a stream pressure sample for tool result size and rawPath', async () => {
  const samples: PressureSample[] = []
  const deps = makeDeps({
    config: {
      ...makeDeps().config,
      toolRegistry: {
        execute: async () => ({ content: 'x'.repeat(120_000), rawPath: '/tmp/rivet-raw/tu.raw', isError: false }),
        get: () => ({ definition: { input_schema: {} }, isConcurrencySafe: () => false }),
        needsApproval: () => false,
      },
    } as any,
  })

  await executeToolUse(
    { id: 'tu-pressure', name: 'read_file', input: { file_path: '/tmp/huge.txt' } },
    deps,
    { ...noopCallbacks, onPressureSample: sample => samples.push(sample) } as any,
    1,
    false,
  )

  const sample = samples.find(s => s.domain === 'stream' && s.metrics.hasRawPath === 1)
  assert.ok(sample)
  assert.equal(sample.metrics.resultChars, 120_000)
  assert.equal(sample.recommendation?.action, 'spill')
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：

```bash
npm test -- src/agent/__tests__/tool-pipeline.test.ts
```

预期：FAIL，tool pipeline 没有发 pressure sample。

- [ ] **步骤 3：给 ToolPipelineDeps/AgentCallbacks 路径接入 sample helper**

在 `src/agent/tool-pipeline.ts` import：

```typescript
import { createToolResultPressureSample } from '../pressure/stream-sample.js'
```

在 `callbacks.onToolResult(...)` 后、`deps.recordToolHistory(...)` 前加入：

```typescript
callbacks.onPressureSample?.(createToolResultPressureSample({
  toolName: tu.name,
  resultChars: harnessResult.content.length,
  hasRawPath: rawToolResult?.rawPath !== undefined,
  isError: harnessResult.isError,
}))
```

不要用 `finalContent.length` 作为原始大小，因为 `finalContent` 可能已被 `truncateSuccessfulToolResult()` 截断；pressure sample 应测真实 tool payload 大小。

- [ ] **步骤 4：运行测试验证通过**

运行：

```bash
npm test -- src/agent/__tests__/tool-pipeline.test.ts
npm run typecheck
```

预期：PASS。

- [ ] **步骤 5：Commit**

```bash
git add src/agent/tool-pipeline.ts src/agent/__tests__/tool-pipeline.test.ts
git commit -m "feat(agent): sample tool result pressure"
```

---

### 任务 6：WorkOrderQueue snapshot + coordinator workQueue samples

**文件：**
- 修改：`src/agent/work-queue.ts:8-63`
- 修改：`src/agent/coordinator.ts:51-58,171-237`
- 修改：`src/agent/__tests__/work-queue.test.ts:19-96`
- 修改：`src/agent/__tests__/coordinator.test.ts:165-260`

- [ ] **步骤 1：编写 WorkOrderQueue snapshot 失败测试**

追加到 `src/agent/__tests__/work-queue.test.ts`：

```typescript
it('reports a read-only pressure snapshot', () => {
  const q = new WorkOrderQueue(2)
  const parent = order('parent', 'parent')
  const child = order('child', 'child', ['parent'])

  q.enqueue(child)
  q.enqueue(parent)
  q.markInFlight(q.dequeue()!)

  assert.deepEqual(q.snapshot(), {
    pending: 1,
    inFlight: 1,
    maxConcurrency: 2,
    dependencyBlocked: 1,
  })
})
```

- [ ] **步骤 2：编写 coordinator sample 失败测试**

在 `src/agent/__tests__/coordinator.test.ts` imports 中加入：

```typescript
import type { PressureSample } from '../../pressure/types.js'
```

追加测试：

```typescript
it('emits workQueue pressure samples during batch delegation', async () => {
  const samples: PressureSample[] = []
  const coordinator = new DelegationCoordinator({
    baseToolRegistry: makeRegistry(),
    modelCards: cards,
    maxWorkers: 1,
    onPressureSample: sample => samples.push(sample),
    runtimeFactory: (order, card, workerRegistry) => ({
      order,
      client: {} as ApiClient,
      promptEngine: new PromptEngine({ model: card.model, maxTokens: 1024, staticCtx: { tools: workerRegistry.getDefinitions() }, volatileCtx: { cwd: '/repo' } }),
      toolRegistry: workerRegistry,
      cwd: '/repo',
      maxTurns: 2,
      contextWindow: card.contextWindow,
      compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' },
    }),
    runWorker: async config => ({
      result: resultFor(config.order.id),
      transcript: { text: '', thinking: '', toolUses: [], toolResults: [], errors: [], repairAttempts: 0 },
      session: { getTurnCount: () => 1 } as never,
      usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    }),
  })

  await coordinator.delegateBatch([
    { parentTurnId: 'turn_q', objective: 'Search routing seams across the main module.', kind: 'code_search', profile: 'code_scout', scope: { files: ['src/main.tsx'] } },
    { parentTurnId: 'turn_q', objective: 'Review coordinator risks across delegation module boundary.', kind: 'review', profile: 'reviewer', scope: { files: ['src/agent/coordinator.ts', 'src/agent/work-order.ts'] } },
  ])

  assert.ok(samples.some(sample => sample.domain === 'workQueue'))
  assert.ok(samples.every(sample => sample.metrics.maxConcurrency === 1))
})
```

- [ ] **步骤 3：运行测试验证失败**

运行：

```bash
npm test -- src/agent/__tests__/work-queue.test.ts src/agent/__tests__/coordinator.test.ts
```

预期：FAIL，`snapshot` / `onPressureSample` 不存在。

- [ ] **步骤 4：实现 WorkOrderQueue snapshot**

```typescript
// src/agent/work-queue.ts
export interface WorkQueueSnapshot {
  pending: number
  inFlight: number
  maxConcurrency: number
  dependencyBlocked: number
}
```

在 `WorkOrderQueue` 类中加入：

```typescript
snapshot(): WorkQueueSnapshot {
  const dependencyBlocked = this.entries.filter(e =>
    !e.order.dependencies.every(dep => this.completedIds.has(dep)),
  ).length

  return {
    pending: this.entries.length,
    inFlight: this.inFlightKeys.size,
    maxConcurrency: this.maxConcurrency,
    dependencyBlocked,
  }
}
```

- [ ] **步骤 5：实现 workQueue pressure sample helper 内联函数**

在 `src/agent/coordinator.ts` import：

```typescript
import type { PressureSample } from '../pressure/types.js'
```

在 `DelegationCoordinatorConfig` 增加：

```typescript
onPressureSample?: (sample: PressureSample) => void
```

在文件中加入局部 helper：

```typescript
function workQueuePressureSample(snapshot: ReturnType<WorkOrderQueue['snapshot']>): PressureSample {
  const ratio = snapshot.maxConcurrency > 0 ? snapshot.inFlight / snapshot.maxConcurrency : 1
  const level = snapshot.pending > snapshot.maxConcurrency || ratio >= 1 ? 'some' : 'normal'
  return {
    domain: 'workQueue',
    level,
    measuredAt: Date.now(),
    metrics: {
      pending: snapshot.pending,
      inFlight: snapshot.inFlight,
      maxConcurrency: snapshot.maxConcurrency,
      dependencyBlocked: snapshot.dependencyBlocked,
    },
  }
}
```

在 `delegateBatch()` 中 `enqueue` 完成后、`markInFlight` 后、`markCompleted/markFailed` 后调用：

```typescript
this.config.onPressureSample?.(workQueuePressureSample(queue.snapshot()))
```

- [ ] **步骤 6：运行测试验证通过**

运行：

```bash
npm test -- src/agent/__tests__/work-queue.test.ts src/agent/__tests__/coordinator.test.ts
npm run typecheck
```

预期：PASS。

- [ ] **步骤 7：Commit**

```bash
git add src/agent/work-queue.ts src/agent/coordinator.ts src/agent/__tests__/work-queue.test.ts src/agent/__tests__/coordinator.test.ts
git commit -m "feat(agent): sample work queue pressure"
```

---

### 任务 7：TUI 本地 recorder 接线

**文件：**
- 修改：`src/tui/app.tsx:235-243`
- 修改：`src/tui/app.tsx:590-612`
- 修改：`src/tui/app.tsx:673-755`
- 修改：`src/tui/app.tsx:759-815`

- [ ] **步骤 1：修改 imports 和 refs**

在 `src/tui/app.tsx` import：

```typescript
import { PressureRecorder } from '../pressure/recorder.js'
import type { PressureSample } from '../pressure/types.js'
```

在 `streamBuf` refs 附近加入：

```typescript
const pressureRecorder = useRef(new PressureRecorder())
const recordPressure = useCallback((sample: PressureSample) => {
  pressureRecorder.current.record(sample)
}, [])
```

- [ ] **步骤 2：把 RenderBatcher flush sample 转成 render domain sample**

把 `textBatcher` 初始化改为：

```typescript
const textBatcher = useRef(new RenderBatcher<string>(
  (texts) => {
    const combined = texts.join('')
    streamBuf.current += combined
    setStreamingText(prev => appendStreamWindow(prev, combined, LIVE_STREAM_MAX_CHARS))
  },
  {
    onFlushSample: sample => recordPressure({
      domain: 'render',
      level: sample.flushLatencyMs >= 50 || sample.pendingBeforeFlush >= 100 ? 'some' : 'normal',
      measuredAt: Date.now(),
      metrics: {
        itemCount: sample.itemCount,
        pendingBeforeFlush: sample.pendingBeforeFlush,
        flushLatencyMs: sample.flushLatencyMs,
        flushedBySync: sample.flushedBy === 'sync' ? 1 : 0,
      },
    }),
  },
))
```

如果 TypeScript 报 `recordPressure` 在声明前使用，则把 `pressureRecorder` 和 `recordPressure` 移到 `textBatcher` 前。

- [ ] **步骤 3：把 AgentLoop samples 接入 recorder**

在 `agent.run()` callbacks 中加入：

```typescript
onPressureSample: recordPressure,
```

不要把 sample 拼到 prompt、session messages、tool result 或 visible assistant text。

- [ ] **步骤 4：运行 targeted checks**

运行：

```bash
npm run typecheck
npm test -- src/tui/__tests__/render-batch.test.ts src/agent/__tests__/loop.test.ts src/agent/__tests__/tool-pipeline.test.ts
```

预期：PASS。

- [ ] **步骤 5：Commit**

```bash
git add src/tui/app.tsx
git commit -m "feat(tui): record pressure samples locally"
```

---

## Phase 2：priority lanes + bounded queues

### 任务 8：新增 BoundedLaneQueue

**文件：**
- 创建：`src/pressure/bounded-lane.ts`
- 创建：`src/pressure/__tests__/bounded-lane.test.ts`

- [ ] **步骤 1：编写失败测试**

```typescript
// src/pressure/__tests__/bounded-lane.test.ts
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { BoundedLaneQueue } from '../bounded-lane.js'

describe('BoundedLaneQueue', () => {
  it('enforces background capacity', () => {
    const queue = new BoundedLaneQueue<string>({ backgroundCapacity: 2 })

    assert.equal(queue.enqueue('a', 'background'), true)
    assert.equal(queue.enqueue('b', 'background'), true)
    assert.equal(queue.enqueue('c', 'background'), false)
    assert.deepEqual(queue.snapshot(), { control: 0, interactive: 0, background: 2, dropped: 1 })
  })

  it('lets control lane bypass background capacity', () => {
    const queue = new BoundedLaneQueue<string>({ backgroundCapacity: 1 })

    assert.equal(queue.enqueue('background-1', 'background'), true)
    assert.equal(queue.enqueue('background-2', 'background'), false)
    assert.equal(queue.enqueue('abort', 'control'), true)

    assert.deepEqual(queue.drain(), ['abort', 'background-1'])
  })

  it('orders control before interactive before background', () => {
    const queue = new BoundedLaneQueue<string>({ backgroundCapacity: 10 })

    queue.enqueue('background', 'background')
    queue.enqueue('interactive', 'interactive')
    queue.enqueue('control', 'control')

    assert.deepEqual(queue.drain(), ['control', 'interactive', 'background'])
  })
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：

```bash
npm test -- src/pressure/__tests__/bounded-lane.test.ts
```

预期：FAIL，module 不存在。

- [ ] **步骤 3：实现 BoundedLaneQueue**

```typescript
// src/pressure/bounded-lane.ts
import type { PressurePriority } from './types.js'

export interface BoundedLaneQueueConfig {
  backgroundCapacity: number
  interactiveCapacity?: number
}

export interface BoundedLaneSnapshot {
  control: number
  interactive: number
  background: number
  dropped: number
}

export class BoundedLaneQueue<T> {
  private control: T[] = []
  private interactive: T[] = []
  private background: T[] = []
  private dropped = 0

  constructor(private readonly config: BoundedLaneQueueConfig) {}

  enqueue(item: T, priority: PressurePriority): boolean {
    if (priority === 'control') {
      this.control = [...this.control, item]
      return true
    }

    if (priority === 'interactive') {
      const cap = this.config.interactiveCapacity ?? Number.POSITIVE_INFINITY
      if (this.interactive.length >= cap) {
        this.dropped++
        return false
      }
      this.interactive = [...this.interactive, item]
      return true
    }

    if (this.background.length >= this.config.backgroundCapacity) {
      this.dropped++
      return false
    }
    this.background = [...this.background, item]
    return true
  }

  drain(): T[] {
    const items = [...this.control, ...this.interactive, ...this.background]
    this.control = []
    this.interactive = []
    this.background = []
    return items
  }

  snapshot(): BoundedLaneSnapshot {
    return {
      control: this.control.length,
      interactive: this.interactive.length,
      background: this.background.length,
      dropped: this.dropped,
    }
  }
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：

```bash
npm test -- src/pressure/__tests__/bounded-lane.test.ts
```

预期：PASS。

- [ ] **步骤 5：Commit**

```bash
git add src/pressure/bounded-lane.ts src/pressure/__tests__/bounded-lane.test.ts
git commit -m "feat(pressure): add bounded priority lane queue"
```

---

### 任务 9：把 bounded lane 用于后台聚合，不阻塞 control path

**文件：**
- 修改：`src/agent/coordinator.ts:171-237`
- 修改：`src/agent/__tests__/coordinator.test.ts`

- [ ] **步骤 1：编写失败测试**

在 `src/agent/__tests__/coordinator.test.ts` 新增：

```typescript
it('keeps batch aggregation pressure visible without blocking worker completion', async () => {
  const samples: PressureSample[] = []
  const completed: string[] = []
  const coordinator = new DelegationCoordinator({
    baseToolRegistry: makeRegistry(),
    modelCards: cards,
    maxWorkers: 1,
    onPressureSample: sample => samples.push(sample),
    runtimeFactory: (order, card, workerRegistry) => ({
      order,
      client: {} as ApiClient,
      promptEngine: new PromptEngine({ model: card.model, maxTokens: 1024, staticCtx: { tools: workerRegistry.getDefinitions() }, volatileCtx: { cwd: '/repo' } }),
      toolRegistry: workerRegistry,
      cwd: '/repo',
      maxTurns: 2,
      contextWindow: card.contextWindow,
      compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' },
    }),
    runWorker: async config => {
      completed.push(config.order.id)
      return {
        result: resultFor(config.order.id),
        transcript: { text: '', thinking: '', toolUses: [], toolResults: [], errors: [], repairAttempts: 0 },
        session: { getTurnCount: () => 1 } as never,
        usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      }
    },
  })

  const run = await coordinator.delegateBatch([
    { parentTurnId: 'turn_lane', objective: 'Search routing seams across main module for pressure lane tests.', kind: 'code_search', profile: 'code_scout', scope: { files: ['src/main.tsx'] } },
    { parentTurnId: 'turn_lane', objective: 'Review coordinator risks across delegation boundary for pressure lane tests.', kind: 'review', profile: 'reviewer', scope: { files: ['src/agent/coordinator.ts', 'src/agent/work-order.ts'] } },
  ])

  assert.equal(run.status, 'completed')
  assert.equal(completed.length, 2)
  assert.ok(samples.some(sample => sample.domain === 'workQueue'))
})
```

- [ ] **步骤 2：运行测试验证当前行为**

运行：

```bash
npm test -- src/agent/__tests__/coordinator.test.ts
```

预期：PASS 或 FAIL。如果 PASS，说明 Phase 1 sample 已满足本任务的最小要求；继续步骤 3 做内部结构整理。若 FAIL，按失败信息补齐 sample 调用。

- [ ] **步骤 3：只在 aggregation 内部使用 bounded lane，不改变 public API**

在 `delegateBatch()` 内部创建 background lane，用于聚合阶段的结果入队：

```typescript
const resultLane = new BoundedLaneQueue<WorkerResult>({ backgroundCapacity: Math.max(this.config.maxWorkers * 4, 4) })
```

worker 完成时，把 `run.results` 逐条经过 bounded lane，再 drain 回 `allResults`：

```typescript
for (const workerResult of run.results) {
  if (!resultLane.enqueue(workerResult, 'background')) {
    allResults.push(...resultLane.drain())
    this.config.onPressureSample?.({
      domain: 'workQueue',
      level: 'some',
      measuredAt: Date.now(),
      metrics: { droppedAggregationResults: 1, maxWorkers: this.config.maxWorkers },
      recommendation: {
        action: 'pause',
        priority: 'background',
        visibleMessage: 'Worker aggregation queue is full; pause new background delegation',
      },
    })
    allResults.push(workerResult)
    continue
  }
}
allResults.push(...resultLane.drain())
```

`enqueue()` 返回 false 时先 drain 已接受的 result，再把当前 `workerResult` push 到 `allResults`，保证 Phase 2 不丢 worker result，也不重排同一 worker 的结果。后续行为改变必须单独设计。

- [ ] **步骤 4：运行测试验证通过**

运行：

```bash
npm test -- src/agent/__tests__/coordinator.test.ts src/pressure/__tests__/bounded-lane.test.ts
npm run typecheck
```

预期：PASS。

- [ ] **步骤 5：Commit**

```bash
git add src/agent/coordinator.ts src/agent/__tests__/coordinator.test.ts
git commit -m "feat(agent): keep worker aggregation pressure visible"
```

---

## Phase 3：ghost manifest + progressive spill metadata

### 任务 10：新增 metadata-only GhostManifest

**文件：**
- 创建：`src/pressure/ghost-manifest.ts`
- 创建：`src/pressure/__tests__/ghost-manifest.test.ts`

- [ ] **步骤 1：编写失败测试**

```typescript
// src/pressure/__tests__/ghost-manifest.test.ts
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { GhostManifest } from '../ghost-manifest.js'

describe('GhostManifest', () => {
  it('stores metadata without retaining payload content', () => {
    const manifest = new GhostManifest(10)
    manifest.record({ id: 'tool:1', kind: 'tool_result', tokensOrBytes: 120_000, rawPath: '/tmp/rivet-raw/1.raw', turn: 3 })

    assert.deepEqual(manifest.entries(), [{
      id: 'tool:1',
      kind: 'tool_result',
      tokensOrBytes: 120_000,
      rawPath: '/tmp/rivet-raw/1.raw',
      evictedAtTurn: 3,
      lastAccessTurn: 3,
      accessCount: 0,
    }])
    assert.equal(JSON.stringify(manifest.entries()).includes('x'.repeat(100)), false)
  })

  it('touch updates access metadata', () => {
    const manifest = new GhostManifest(10)
    manifest.record({ id: 'turn:1', kind: 'turn', tokensOrBytes: 4000, turn: 1 })
    manifest.touch('turn:1', 5)

    const entry = manifest.entries()[0]!
    assert.equal(entry.accessCount, 1)
    assert.equal(entry.lastAccessTurn, 5)
  })

  it('evicts least-recently accessed metadata when capacity is exceeded', () => {
    const manifest = new GhostManifest(2)
    manifest.record({ id: 'a', kind: 'tool_result', tokensOrBytes: 1, turn: 1 })
    manifest.record({ id: 'b', kind: 'tool_result', tokensOrBytes: 1, turn: 2 })
    manifest.touch('a', 3)
    manifest.record({ id: 'c', kind: 'tool_result', tokensOrBytes: 1, turn: 4 })

    assert.deepEqual(manifest.entries().map(e => e.id), ['a', 'c'])
  })
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：

```bash
npm test -- src/pressure/__tests__/ghost-manifest.test.ts
```

预期：FAIL，module 不存在。

- [ ] **步骤 3：实现 GhostManifest**

```typescript
// src/pressure/ghost-manifest.ts
export type GhostEntryKind = 'tool_result' | 'turn' | 'worker_result' | 'render_segment'

export interface GhostManifestRecordInput {
  id: string
  kind: GhostEntryKind
  tokensOrBytes: number
  rawPath?: string
  turn: number
}

export interface GhostManifestEntry {
  id: string
  kind: GhostEntryKind
  tokensOrBytes: number
  rawPath?: string
  evictedAtTurn: number
  lastAccessTurn: number
  accessCount: number
}

export class GhostManifest {
  private items = new Map<string, GhostManifestEntry>()

  constructor(private readonly capacity = 500) {}

  record(input: GhostManifestRecordInput): void {
    const existing = this.items.get(input.id)
    this.items.set(input.id, {
      id: input.id,
      kind: input.kind,
      tokensOrBytes: input.tokensOrBytes,
      rawPath: input.rawPath,
      evictedAtTurn: existing?.evictedAtTurn ?? input.turn,
      lastAccessTurn: input.turn,
      accessCount: existing?.accessCount ?? 0,
    })
    this.trim()
  }

  touch(id: string, turn: number): void {
    const existing = this.items.get(id)
    if (!existing) return
    this.items.set(id, {
      ...existing,
      lastAccessTurn: turn,
      accessCount: existing.accessCount + 1,
    })
  }

  entries(): GhostManifestEntry[] {
    return [...this.items.values()].sort((a, b) => a.evictedAtTurn - b.evictedAtTurn)
  }

  private trim(): void {
    while (this.items.size > this.capacity) {
      const oldest = [...this.items.values()].sort((a, b) =>
        a.lastAccessTurn === b.lastAccessTurn
          ? a.evictedAtTurn - b.evictedAtTurn
          : a.lastAccessTurn - b.lastAccessTurn,
      )[0]
      if (!oldest) return
      this.items.delete(oldest.id)
    }
  }
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：

```bash
npm test -- src/pressure/__tests__/ghost-manifest.test.ts
```

预期：PASS。

- [ ] **步骤 5：Commit**

```bash
git add src/pressure/ghost-manifest.ts src/pressure/__tests__/ghost-manifest.test.ts
git commit -m "feat(pressure): add ghost manifest metadata store"
```

---

### 任务 11：记录 tool result ghost metadata，不改变 tool result 内容

**文件：**
- 修改：`src/agent/loop.ts:55-78`
- 修改：`src/agent/tool-pipeline.ts:288-304,413`
- 修改：`src/agent/__tests__/tool-pipeline.test.ts`

- [ ] **步骤 1：扩展 AgentConfig**

在 `src/agent/loop.ts` import：

```typescript
import type { GhostManifest } from '../pressure/ghost-manifest.js'
```

在 `AgentConfig` 中加入：

```typescript
ghostManifest?: GhostManifest
```

- [ ] **步骤 2：把 ghostManifest 传给 ToolPipelineDeps**

在 `src/agent/tool-pipeline.ts` 的 `ToolPipelineDeps` 增加：

```typescript
ghostManifest?: import('../pressure/ghost-manifest.js').GhostManifest
```

在 `src/agent/loop.ts:626-648` 的 `pipelineDeps` 中加入：

```typescript
ghostManifest: this.config.ghostManifest,
```

- [ ] **步骤 3：编写失败测试**

在 `src/agent/__tests__/tool-pipeline.test.ts` 增加：

```typescript
it('records ghost metadata for rawPath tool results without changing returned content', async () => {
  const manifest = new GhostManifest(10)
  const deps = makeDeps({
    ghostManifest: manifest,
    config: {
      ...makeDeps().config,
      toolRegistry: {
        execute: async () => ({ content: 'visible preview', rawPath: '/tmp/rivet-raw/tu.raw', isError: false }),
        get: () => ({ definition: { input_schema: {} }, isConcurrencySafe: () => false }),
        needsApproval: () => false,
      },
    } as any,
  } as Partial<ToolPipelineDeps>)

  const result = await executeToolUse(
    { id: 'tu-ghost', name: 'read_file', input: { file_path: '/tmp/huge.txt' } },
    deps,
    noopCallbacks as any,
    7,
    false,
  )

  assert.equal((result.toolResult as any).content, 'visible preview')
  assert.deepEqual(manifest.entries().map(e => ({ id: e.id, rawPath: e.rawPath, kind: e.kind })), [
    { id: 'tool_result:tu-ghost', rawPath: '/tmp/rivet-raw/tu.raw', kind: 'tool_result' },
  ])
})
```

Also add imports:

```typescript
import { GhostManifest } from '../../pressure/ghost-manifest.js'
```

- [ ] **步骤 4：运行测试验证失败**

运行：

```bash
npm test -- src/agent/__tests__/tool-pipeline.test.ts
```

预期：FAIL，manifest 未记录。

- [ ] **步骤 5：实现 ghost metadata 记录**

在 `callbacks.onToolResult(...)` 后加入：

```typescript
if (rawToolResult?.rawPath) {
  deps.ghostManifest?.record({
    id: `tool_result:${tu.id}`,
    kind: 'tool_result',
    tokensOrBytes: harnessResult.content.length,
    rawPath: rawToolResult.rawPath,
    turn,
  })
}
```

- [ ] **步骤 6：运行测试验证通过**

运行：

```bash
npm test -- src/agent/__tests__/tool-pipeline.test.ts
npm run typecheck
```

预期：PASS。

- [ ] **步骤 7：Commit**

```bash
git add src/agent/loop.ts src/agent/tool-pipeline.ts src/agent/__tests__/tool-pipeline.test.ts
git commit -m "feat(agent): record tool result ghost metadata"
```

---

## Phase 4：Sensorium/Stigmergy 适配

### 任务 12：pressure samples 只作为 Sensorium 输入

**文件：**
- 修改：`src/agent/sensorium.ts`
- 修改：`src/agent/__tests__/sensorium.test.ts`
- 修改：`src/agent/loop.ts:468-483`

- [ ] **步骤 1：编写失败测试**

在 `src/agent/__tests__/sensorium.test.ts` 增加：

```typescript
it('incorporates pressure samples without commanding runtime policy', () => {
  const sensorium = computeSensorium({
    predictionAcc: { windowSize: 10, predictions: [], consecutiveCorrect: 0 },
    pressureResult: { tier: 0, shouldCompact: false, thrashing: false, ratio: 0.2 },
    evidenceState: { filesModified: 0, verifiedCount: 0 },
    toolCallHistory: [],
    pheromones: [],
    doomLevel: 'none',
    pressureSamples: [
      { domain: 'render', level: 'some', measuredAt: 1, metrics: { flushLatencyMs: 60 } },
      { domain: 'stream', level: 'full', measuredAt: 2, metrics: { resultChars: 120_000 } },
    ],
  })

  assert.ok(sensorium.pressure > 0.2)
  assert.ok(sensorium.stability < 1)
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：

```bash
npm test -- src/agent/__tests__/sensorium.test.ts
```

预期：FAIL，`pressureSamples` 不在 `SensoriumInput` 类型中。

- [ ] **步骤 3：扩展 SensoriumInput**

在 `src/agent/sensorium.ts` import：

```typescript
import type { PressureSample } from '../pressure/types.js'
```

在 `SensoriumInput` 的 `doomLevel` 后增加：

```typescript
pressureSamples?: PressureSample[]
```

在 `computeStability()` 后加入：

```typescript
function computeSamplePressure(samples: PressureSample[] | undefined): number {
  return clamp((samples ?? []).reduce((score, sample) => {
    if (sample.level === 'full') return score + 0.25
    if (sample.level === 'some') return score + 0.1
    return score
  }, 0))
}
```

把当前 `computeSensorium()` 整体替换为：

```typescript
export function computeSensorium(input: SensoriumInput): Sensorium {
  const basePressure = computePressure(input.pressureResult)
  const samplePressure = computeSamplePressure(input.pressureSamples)
  const baseStability = computeStability(input.doomLevel)

  return {
    momentum: computeMomentum(input.predictionAcc),
    pressure: clamp(basePressure + samplePressure),
    confidence: computeConfidence(input.evidenceState),
    complexity: computeComplexity(input.toolCallHistory),
    freshness: computeFreshness(input.pheromones),
    stability: clamp(baseStability - samplePressure * 0.5),
  }
}
```

这只把 pressure samples 作为纯输入合成到感知值，不从 Sensorium 发出 pause/compact/spill 命令。

- [ ] **步骤 4：AgentLoop 传最近 samples**

在 `AgentLoop` 中增加私有字段：

```typescript
private recentPressureSamples: PressureSample[] = []
```

在 `callbacks.onPressureSample?.(...)` 调用旁边不要直接读回 callback；改为本地 helper：

```typescript
private recordPressureSample(sample: PressureSample, callbacks: AgentCallbacks): void {
  this.recentPressureSamples = [...this.recentPressureSamples, sample].slice(-20)
  callbacks.onPressureSample?.(sample)
}
```

把 Phase 1 中直接调用 `callbacks.onPressureSample?.(...)` 的位置替换为 `this.recordPressureSample(sample, callbacks)`。

在 `sensoriumInput` 中加入：

```typescript
pressureSamples: this.recentPressureSamples,
```

- [ ] **步骤 5：运行测试验证通过**

运行：

```bash
npm test -- src/agent/__tests__/sensorium.test.ts src/agent/__tests__/loop.test.ts
npm run typecheck
```

预期：PASS。

- [ ] **步骤 6：Commit**

```bash
git add src/agent/sensorium.ts src/agent/loop.ts src/agent/__tests__/sensorium.test.ts src/agent/__tests__/loop.test.ts
git commit -m "feat(agent): feed pressure samples into sensorium"
```

---

## 最终验证

- [ ] **步骤 1：运行 focused tests**

```bash
npm test -- src/pressure/__tests__/recorder.test.ts src/pressure/__tests__/context-sample.test.ts src/pressure/__tests__/stream-sample.test.ts src/pressure/__tests__/bounded-lane.test.ts src/pressure/__tests__/ghost-manifest.test.ts src/tui/__tests__/render-batch.test.ts src/agent/__tests__/work-queue.test.ts src/agent/__tests__/coordinator.test.ts src/agent/__tests__/tool-pipeline.test.ts src/agent/__tests__/loop.test.ts src/agent/__tests__/sensorium.test.ts
```

预期：PASS。

- [ ] **步骤 2：运行 typecheck**

```bash
npm run typecheck
```

预期：PASS。

- [ ] **步骤 3：运行全量测试**

```bash
npm test
```

预期：PASS。

- [ ] **步骤 4：运行 build**

```bash
npm run build
```

预期：PASS。

- [ ] **步骤 5：检查 DeepSeek cache boundary**

运行一次静态 diff 检查，确保以下文件没有因为 pressure telemetry 改动 system/tool prefix 组装：

```bash
git diff -- src/prompt/engine.ts src/api/client.ts src/api/openai-client.ts src/api/stable-json.ts
```

预期：无 diff，或 diff 与 pressure-control 无关且已单独解释。

- [ ] **步骤 6：最终 commit**

如果前面每个任务已独立 commit，这一步只做状态检查：

```bash
git status --short
```

预期：无未提交实现文件；若只有计划/进度文档，按用户要求单独提交文档。

---

## 实施顺序建议

1. 先执行 Phase 0 和 Phase 1。Phase 1 是 measurement-only，可安全合入。
2. Phase 2 在 Phase 1 指标稳定后执行，避免没有基线就改变 queue 行为。
3. Phase 3 只记录 metadata，不把 ghost manifest 接入 eviction 决策。
4. Phase 4 最晚执行，因为当前 `src/agent/loop.ts` 与 `src/agent/star-event.ts` 已有未提交改动，Sensorium 接线最容易产生冲突。

## 设计边界

- 本计划不实现完整 ACF 冷存储和 recall。
- 本计划不实现 R3 recovery panel。
- 本计划不实现 R4 live benchmark runner。
- 本计划不改变 provider cache strategy。
- 本计划不让模型读取 pressure telemetry。
