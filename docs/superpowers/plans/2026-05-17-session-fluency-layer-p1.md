# Session Fluency Layer Phase 1 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 实现纯逻辑的 fluency-policy helper + stage-health 计算，不改 UI 渲染。为 Phase 2 的 UI 接入提供可测试的策略引擎。

**架构：** 新建 `src/tui/fluency-policy.ts`（纯函数，无副作用），消费现有 ActivityStatus 状态，输出 UI 可见性策略。不新增面板、不改 app.tsx、不改 AgentLoop。

**技术栈：** TypeScript, 纯函数, 现有 ActivityStatus 类型。

**前置条件：** content-preservation 计划已完成（LogEntry 有 thinking 字段）。ActivityStatus 已有 phase/stale 基础设施。

**设计来源：** [`docs/superpowers/specs/2026-05-17-rivet-tui-session-fluency-layer-design.md`](../specs/2026-05-17-rivet-tui-session-fluency-layer-design.md)

---

## 文件结构

| 文件 | 操作 | 职责 |
|------|------|------|
| `src/tui/fluency-policy.ts` | 创建 | 纯策略计算：输入信号 → 输出 UI policy |
| `src/tui/__tests__/fluency-policy.test.ts` | 创建 | 策略逻辑单元测试 |

---

### 任务 1：定义类型和核心策略函数

**文件：**
- 创建：`src/tui/fluency-policy.ts`
- 创建：`src/tui/__tests__/fluency-policy.test.ts`

- [ ] **步骤 1：编写失败的测试**

```typescript
// src/tui/__tests__/fluency-policy.test.ts
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { computeFluencyPolicy, type FluencySignals } from '../fluency-policy.js'

describe('computeFluencyPolicy', () => {
  const base: FluencySignals = {
    phase: 'tool',
    silentMs: 0,
    outputRate: 100,    // chars/sec
    resultLength: 500,
    contextPressure: 0.3,
    isError: false,
    isApproval: false,
    consecutiveRoutine: 0,
  }

  it('returns "normal" for typical tool execution', () => {
    const policy = computeFluencyPolicy(base)
    assert.strictEqual(policy.visibility, 'normal')
    assert.strictEqual(policy.foldRoutine, false)
  })

  it('returns "quiet" after many consecutive routine events', () => {
    const policy = computeFluencyPolicy({ ...base, consecutiveRoutine: 5 })
    assert.strictEqual(policy.visibility, 'quiet')
    assert.strictEqual(policy.foldRoutine, true)
  })

  it('returns "inspect" when silent too long', () => {
    const policy = computeFluencyPolicy({ ...base, silentMs: 15_000 })
    assert.strictEqual(policy.visibility, 'inspect')
    assert.ok(policy.staleMessage)
  })

  it('returns "stress" under high context pressure', () => {
    const policy = computeFluencyPolicy({ ...base, contextPressure: 0.9 })
    assert.strictEqual(policy.visibility, 'stress')
    assert.ok(policy.coalesceMs >= 1000)
  })

  it('never folds errors or approvals', () => {
    const errorPolicy = computeFluencyPolicy({ ...base, isError: true, consecutiveRoutine: 10 })
    assert.strictEqual(errorPolicy.foldRoutine, false)
    assert.strictEqual(errorPolicy.visibility, 'inspect')

    const approvalPolicy = computeFluencyPolicy({ ...base, isApproval: true, consecutiveRoutine: 10 })
    assert.strictEqual(approvalPolicy.foldRoutine, false)
  })

  it('returns higher coalesceMs in quiet mode', () => {
    const quiet = computeFluencyPolicy({ ...base, consecutiveRoutine: 5 })
    const normal = computeFluencyPolicy(base)
    assert.ok(quiet.coalesceMs > normal.coalesceMs)
  })

  it('marks large results as needing inspection', () => {
    const policy = computeFluencyPolicy({ ...base, resultLength: 50_000 })
    assert.strictEqual(policy.suggestFold, true)
  })
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npm test -- --test-name-pattern "computeFluencyPolicy" 2>&1 | tail -5`
预期：FAIL，`Cannot find module '../fluency-policy.js'`

- [ ] **步骤 3：实现 fluency-policy.ts**

```typescript
// src/tui/fluency-policy.ts

import type { ActivityPhase } from './activity-status.js'

export interface FluencySignals {
  phase: ActivityPhase | string
  silentMs: number           // ms since last event
  outputRate: number         // chars/sec of current stream
  resultLength: number       // length of last tool result
  contextPressure: number    // 0-1, ratio of used context window
  isError: boolean
  isApproval: boolean
  consecutiveRoutine: number // count of consecutive non-surprising events
}

export type Visibility = 'quiet' | 'normal' | 'inspect' | 'stress'

export interface FluencyPolicy {
  visibility: Visibility
  coalesceMs: number
  foldRoutine: boolean
  suggestFold: boolean
  staleMessage?: string
}

const STALE_THRESHOLD_MS = 12_000
const STRESS_CONTEXT_THRESHOLD = 0.85
const ROUTINE_HABITUATION = 4
const LARGE_RESULT_THRESHOLD = 20_000

export function computeFluencyPolicy(signals: FluencySignals): FluencyPolicy {
  // Errors and approvals always escalate — never fold
  if (signals.isError) {
    return {
      visibility: 'inspect',
      coalesceMs: 200,
      foldRoutine: false,
      suggestFold: false,
      staleMessage: undefined,
    }
  }

  if (signals.isApproval) {
    return {
      visibility: 'normal',
      coalesceMs: 200,
      foldRoutine: false,
      suggestFold: false,
    }
  }

  // Stress: high context pressure
  if (signals.contextPressure >= STRESS_CONTEXT_THRESHOLD) {
    return {
      visibility: 'stress',
      coalesceMs: 1500,
      foldRoutine: true,
      suggestFold: true,
      staleMessage: `Context pressure ${Math.round(signals.contextPressure * 100)}% — consider /compact`,
    }
  }

  // Stale: long silence
  if (signals.silentMs >= STALE_THRESHOLD_MS) {
    const seconds = Math.round(signals.silentMs / 1000)
    return {
      visibility: 'inspect',
      coalesceMs: 500,
      foldRoutine: false,
      suggestFold: false,
      staleMessage: `No update for ${seconds}s — ${signals.phase} may be waiting`,
    }
  }

  // Habituation: many consecutive routine events
  if (signals.consecutiveRoutine >= ROUTINE_HABITUATION) {
    return {
      visibility: 'quiet',
      coalesceMs: 1000,
      foldRoutine: true,
      suggestFold: signals.resultLength >= LARGE_RESULT_THRESHOLD,
    }
  }

  // Normal
  return {
    visibility: 'normal',
    coalesceMs: 500,
    foldRoutine: false,
    suggestFold: signals.resultLength >= LARGE_RESULT_THRESHOLD,
  }
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`npx tsc --noEmit && npm test -- --test-name-pattern "computeFluencyPolicy" 2>&1 | tail -10`
预期：7 tests PASS

- [ ] **步骤 5：Commit**

```bash
git add src/tui/fluency-policy.ts src/tui/__tests__/fluency-policy.test.ts
git commit -m "feat(tui): add fluency-policy pure helper — stage health and visibility strategy"
```

---

### 任务 2：Stage Health 计算器

**文件：**
- 修改：`src/tui/fluency-policy.ts`
- 修改：`src/tui/__tests__/fluency-policy.test.ts`

- [ ] **步骤 1：编写失败的测试**

```typescript
// 追加到 src/tui/__tests__/fluency-policy.test.ts
import { computeStageHealth, type StageSnapshot } from '../fluency-policy.js'

describe('computeStageHealth', () => {
  it('returns healthy for short-duration normal phase', () => {
    const snapshot: StageSnapshot = {
      phase: 'tool',
      startedAt: Date.now() - 2000,
      lastEventAt: Date.now() - 500,
      eventCount: 3,
    }
    const health = computeStageHealth(snapshot, Date.now())
    assert.strictEqual(health.status, 'healthy')
  })

  it('returns stale when no events for too long', () => {
    const now = Date.now()
    const snapshot: StageSnapshot = {
      phase: 'thinking',
      startedAt: now - 30_000,
      lastEventAt: now - 20_000,
      eventCount: 1,
    }
    const health = computeStageHealth(snapshot, now)
    assert.strictEqual(health.status, 'stale')
    assert.ok(health.silentMs >= 20_000)
  })

  it('returns long-running for extended but active phase', () => {
    const now = Date.now()
    const snapshot: StageSnapshot = {
      phase: 'tool',
      startedAt: now - 60_000,
      lastEventAt: now - 1000,
      eventCount: 20,
    }
    const health = computeStageHealth(snapshot, now)
    assert.strictEqual(health.status, 'long-running')
  })

  it('returns idle for idle phase', () => {
    const now = Date.now()
    const snapshot: StageSnapshot = {
      phase: 'idle',
      startedAt: now - 5000,
      lastEventAt: now - 5000,
      eventCount: 0,
    }
    const health = computeStageHealth(snapshot, now)
    assert.strictEqual(health.status, 'idle')
  })
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npm test -- --test-name-pattern "computeStageHealth" 2>&1 | tail -5`
预期：FAIL，`computeStageHealth is not a function`

- [ ] **步骤 3：实现 computeStageHealth**

追加到 `src/tui/fluency-policy.ts`：

```typescript
export interface StageSnapshot {
  phase: ActivityPhase | string
  startedAt: number
  lastEventAt: number
  eventCount: number
}

export type StageHealthStatus = 'idle' | 'healthy' | 'stale' | 'long-running'

export interface StageHealth {
  status: StageHealthStatus
  silentMs: number
  durationMs: number
  eventCount: number
}

const LONG_RUNNING_THRESHOLD_MS = 45_000

export function computeStageHealth(snapshot: StageSnapshot, now: number): StageHealth {
  const silentMs = now - snapshot.lastEventAt
  const durationMs = now - snapshot.startedAt

  if (snapshot.phase === 'idle') {
    return { status: 'idle', silentMs, durationMs, eventCount: snapshot.eventCount }
  }

  if (silentMs >= STALE_THRESHOLD_MS) {
    return { status: 'stale', silentMs, durationMs, eventCount: snapshot.eventCount }
  }

  if (durationMs >= LONG_RUNNING_THRESHOLD_MS && silentMs < STALE_THRESHOLD_MS) {
    return { status: 'long-running', silentMs, durationMs, eventCount: snapshot.eventCount }
  }

  return { status: 'healthy', silentMs, durationMs, eventCount: snapshot.eventCount }
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`npx tsc --noEmit && npm test -- --test-name-pattern "computeStageHealth|computeFluencyPolicy" 2>&1 | tail -10`
预期：11 tests PASS

- [ ] **步骤 5：Commit**

```bash
git add src/tui/fluency-policy.ts src/tui/__tests__/fluency-policy.test.ts
git commit -m "feat(tui): add stage-health calculator for fluency layer"
```

---

### 任务 3：Routine Counter（习惯化计数器）

**文件：**
- 修改：`src/tui/fluency-policy.ts`
- 修改：`src/tui/__tests__/fluency-policy.test.ts`

- [ ] **步骤 1：编写失败的测试**

```typescript
// 追加到测试文件
import { RoutineCounter } from '../fluency-policy.js'

describe('RoutineCounter', () => {
  it('increments on routine events', () => {
    const counter = new RoutineCounter()
    counter.record({ isError: false, isApproval: false, isSurprising: false })
    counter.record({ isError: false, isApproval: false, isSurprising: false })
    assert.strictEqual(counter.count, 2)
  })

  it('resets on error', () => {
    const counter = new RoutineCounter()
    counter.record({ isError: false, isApproval: false, isSurprising: false })
    counter.record({ isError: false, isApproval: false, isSurprising: false })
    counter.record({ isError: true, isApproval: false, isSurprising: false })
    assert.strictEqual(counter.count, 0)
  })

  it('resets on surprising event', () => {
    const counter = new RoutineCounter()
    counter.record({ isError: false, isApproval: false, isSurprising: false })
    counter.record({ isError: false, isApproval: false, isSurprising: false })
    counter.record({ isError: false, isApproval: false, isSurprising: true })
    assert.strictEqual(counter.count, 0)
  })

  it('resets on approval', () => {
    const counter = new RoutineCounter()
    counter.record({ isError: false, isApproval: false, isSurprising: false })
    counter.record({ isError: false, isApproval: true, isSurprising: false })
    assert.strictEqual(counter.count, 0)
  })
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npm test -- --test-name-pattern "RoutineCounter" 2>&1 | tail -5`
预期：FAIL

- [ ] **步骤 3：实现 RoutineCounter**

追加到 `src/tui/fluency-policy.ts`：

```typescript
export interface EventSignature {
  isError: boolean
  isApproval: boolean
  isSurprising: boolean
}

export class RoutineCounter {
  private _count = 0

  get count(): number { return this._count }

  record(event: EventSignature): void {
    if (event.isError || event.isApproval || event.isSurprising) {
      this._count = 0
    } else {
      this._count++
    }
  }

  reset(): void { this._count = 0 }
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`npx tsc --noEmit && npm test -- --test-name-pattern "RoutineCounter" 2>&1 | tail -5`
预期：4 tests PASS

- [ ] **步骤 5：运行全量测试**

运行：`npx tsc --noEmit && npm test 2>&1 | grep -E "^ℹ (tests|pass|fail)"`
预期：0 errors, 1050+ pass, 0 fail

- [ ] **步骤 6：Commit**

```bash
git add src/tui/fluency-policy.ts src/tui/__tests__/fluency-policy.test.ts
git commit -m "feat(tui): add RoutineCounter for habituation-based event folding"
```

---

## 自检

1. **设计覆盖度：** Phase 1 三个核心组件全部覆盖 — fluency policy 计算 ✓、stage health ✓、routine counter ✓
2. **占位符扫描：** 无 TODO/TBD，所有步骤有完整代码
3. **类型一致性：** `FluencySignals.consecutiveRoutine` 由 `RoutineCounter.count` 提供；`FluencySignals.silentMs` 由 `StageHealth.silentMs` 提供
4. **与 content-preservation 关系：** 不冲突。本计划不改 LogEntry、不改 app.tsx 回调、不改 history-replay。两者可并行执行。
5. **与 ActivityStatus 关系：** 本计划消费 `ActivityPhase` 类型但不修改 `activity-status.ts`。Phase 2 接入时才会在 app.tsx 中调用 `computeFluencyPolicy`。

---

## Phase 2 预告（不在本计划范围）

Phase 2 将在 `app.tsx` 中：
- 用 `useRef` 维护 `RoutineCounter` 和 `StageSnapshot`
- 在 `onToolResult` / `onTurnComplete` 回调中更新信号
- 将 `computeFluencyPolicy` 的输出投影到 `SummaryBar` 和工具折叠逻辑
- 不新增面板，只修改现有 surfaces 的可见性策略
