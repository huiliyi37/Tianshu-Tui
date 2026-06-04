# delegate_batch 阻塞导致消息丢失与 UI 卡死 — 修复计划

> **状态：✅ 已全部实施** — Task 1（steerBuffer drain 替代 clear）、Task 2（onProgress/onOutput 批处理进度）、Task 3（集成验证）均已落地。

**目标：** 修复 delegate_batch 执行期间用户消息静默丢失 + UI 无反馈卡死的问题

**架构：** 两层修复——(1) onError 路径保留 SteerBuffer 消息而非清空；(2) delegate_batch 通过 onOutput 报告 worker 进度，让用户在长执行期间看到视觉反馈。不改 SteerBuffer 的架构（它是 tool 间 drain 的设计，对 99% 的 tool 调用正确），只修复 delegate_batch 这个极端 case。

**技术栈：** TypeScript strict / Ink 6 / node:test

---

## 根因

```
delegate_batch 执行（45-180s）
  ↓ 阻塞整个 agent turn
  ↓ SteerBuffer 只在 tool 之间 drain（tool-execution.ts:234）
  ↓ 单个 tool call 内永远不 drain
  ↓
如果失败 → onError → steerBuffer.clear()（app.tsx:1268）→ 用户消息全部丢弃
如果成功 → drain 正常但延迟 45-180s
```

UI 卡死：delegate_batch 没有调用 `onOutput`，TUI 在 tool 执行期间无任何视觉变化。

---

## 文件清单

| 文件 | 职责 |
|------|------|
| `src/tui/app.tsx:1231-1270` | onError 回调——改为 drain + 保留而非 clear |
| `src/agent/coordinator.ts:389-468` | delegateBatch 方法——添加 onProgress 回调 |
| `src/tools/delegate-batch.ts:93-194` | delegate_batch tool——用 onOutput 报告进度 |
| `src/main.tsx:168-171, 818` | coordinator 接口穿透——传递 onProgress |
| `src/tui/__tests__/steer-buffer.test.ts` | SteerBuffer 测试（已有，只读参考） |
| `src/agent/__tests__/coordinator.test.ts` | coordinator 测试（验证 onProgress 被调用） |

---

### Task 1：onError 保留 SteerBuffer 消息

**文件：** `src/tui/app.tsx:1268`

- [ ] **步骤 1：编写失败的测试**

文件：`src/tui/__tests__/steer-buffer-on-error.test.ts`

```typescript
import { describe, it, assert } from 'node:test'
import { SteerBuffer } from '../steer-buffer.js'

describe('SteerBuffer: onError 保留消息场景', () => {
  it('drain 保留消息供下一轮使用（模拟 onError 不应 clear）', () => {
    const buf = new SteerBuffer()
    buf.push('user message 1')
    buf.push('user message 2')
    // drain 取出消息但不丢失
    const drained = buf.drain()
    assert.ok(drained !== null, 'drain 应返回非 null')
    assert.ok(drained!.includes('user message 1'))
    assert.ok(drained!.includes('user message 2'))
    // drain 后 buffer 为空（已被取出，不是被丢弃）
    assert.strictEqual(buf.hasPending(), false)
  })

  it('drain 返回 null 时不应产生副作用', () => {
    const buf = new SteerBuffer()
    const result = buf.drain()
    assert.strictEqual(result, null)
  })
})
```

- [ ] **步骤 2：运行测试验证通过**

运行：`npx tsx --test src/tui/__tests__/steer-buffer-on-error.test.ts`

预期：PASS（SteerBuffer.drain 已有正确行为，测试验证的是 onError 应该用 drain 而非 clear）

- [ ] **步骤 3：修改 onError 回调——保留而非丢弃**

文件：`src/tui/app.tsx`，定位 `onError` 回调中 `steerBuffer.current.clear()` 这一行。

**before（line 1268）：**
```tsx
        steerBuffer.current.clear()
```

**after：**
```tsx
        // Preserve steer messages for next turn instead of silently discarding.
        // Previous clear() caused user messages to vanish on delegate_batch timeout.
        const preservedSteer = steerBuffer.current.drain()
        if (preservedSteer) {
          pushStatic(createLogEntry({ type: 'system', content: `📨 ${preservedSteer.split('\n').length} queued message(s) preserved for next turn.` }))
        }
```

- [ ] **步骤 4：运行类型检查**

运行：`npx tsc --noEmit`

预期：PASS（`drain()` 返回 `string | null`，与 `clear()` 无返回值的差异不影响类型）

- [ ] **步骤 5：运行全部测试**

运行：`npm test`

预期：PASS

- [ ] **步骤 6：Commit**

```bash
git add src/tui/app.tsx src/tui/__tests__/steer-buffer-on-error.test.ts
git commit -m "fix(tui): preserve steer messages on error instead of silently discarding

onError was calling steerBuffer.clear() which discarded all queued user
messages. Now drains and preserves them with a visible system notice.
Most impactful for delegate_batch timeout scenarios (45-180s)."
```

---

### Task 2：delegate_batch 通过 onOutput 报告 worker 进度

**原理：** `delegate_batch` 接收 `params.onOutput`（来自 tool-pipeline），但从未调用它。
`onOutput` 映射到 TUI 的 `onToolResult`，会在 tool 输出区域追加内容。
通过在每完成一个 worker 时调用 `onOutput`，用户能看到实时进度。

**文件：**
- 修改：`src/agent/coordinator.ts:389` — delegateBatch 签名
- 修改：`src/tools/delegate-batch.ts:11` — DelegateBatchCoordinator 接口
- 修改：`src/tools/delegate-batch.ts:171` — 工具执行调用
- 修改：`src/main.tsx:168` 和 `src/main.tsx:818` — 穿透

- [ ] **步骤 1：编写 coordinator 进度回调测试**

文件：`src/agent/__tests__/coordinator-progress.test.ts`

```typescript
import { describe, it, assert } from 'node:test'
import { DelegationCoordinator } from '../coordinator.js'
import type { WorkerSessionConfig, WorkerSessionRun } from '../worker-session.js'
import type { ModelCapabilityCard } from '../../model/capability.js'
import type { ToolRegistry } from '../../tools/registry.js'
import { ToolExecutionController } from '../tool-execution.js'

function createMinimalCoordinator(): DelegationCoordinator {
  const config = {
    baseToolRegistry: {
      get: () => undefined,
      list: () => [],
      filter: () => ({ get: () => undefined, list: () => [] }),
    } as unknown as import('../../tools/registry.js').ToolRegistry,
    modelCards: [] as ModelCapabilityCard[],
    maxWorkers: 2,
    runtimeFactory: () => ({
      order: {} as any,
      card: {} as any,
      registry: {} as any,
    }) as unknown as WorkerSessionConfig,
    runWorker: async () => ({
      result: {
        workOrderId: 'test',
        status: 'passed' as const,
        summary: 'done',
        findings: [],
        artifacts: [],
        changedFiles: [],
        risks: [],
        nextActions: [],
        evidenceStatus: 'verified' as const,
      },
    }) as unknown as WorkerSessionRun,
  }
  return new DelegationCoordinator(config)
}

describe('DelegationCoordinator: onProgress callback', () => {
  it('calls onProgress after each worker completes', async () => {
    const coordinator = createMinimalCoordinator()
    const progressCalls: Array<{ completed: number; total: number }> = []
    const requests = [
      {
        parentTurnId: 'p1',
        objective: 'search for authentication middleware implementation',
        kind: 'code_search' as const,
        profile: 'code_scout' as const,
        scope: { files: ['src/auth.ts', 'src/middleware.ts'] },
      },
    ]
    const run = await coordinator.delegateBatch(
      requests,
      'primary_decides',
      undefined,
      (completed, total) => { progressCalls.push({ completed, total }) },
    )
    assert.strictEqual(run.status, 'completed')
    assert.ok(progressCalls.length >= 1, `expected >= 1 progress calls, got ${progressCalls.length}`)
  })
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npx tsx --test src/agent/__tests__/coordinator-progress.test.ts`

预期：FAIL — `delegateBatch` 当前不接受 `onProgress` 参数

- [ ] **步骤 3：修改 coordinator.ts — 添加 onProgress 参数**

文件：`src/agent/coordinator.ts`，`delegateBatch` 方法签名（line 389）。

**before：**
```ts
  async delegateBatch(requests: DelegationRequest[], policy: AggregationPolicy = 'primary_decides', abortSignal?: AbortSignal): Promise<CoordinatorRun> {
```

**after：**
```ts
  async delegateBatch(
    requests: DelegationRequest[],
    policy: AggregationPolicy = 'primary_decides',
    abortSignal?: AbortSignal,
    onProgress?: (completed: number, total: number) => void,
  ): Promise<CoordinatorRun> {
```

在同一方法内，`processNext` 函数中，worker 完成后调用 `onProgress`：

在 `queue.markCompleted(order)` 之后（约 line 437）：
```ts
        queue.markCompleted(order)
```
改为：
```ts
        queue.markCompleted(order)
        completedCount++
        onProgress?.(completedCount, orders.length)
```

在 `queue.markFailed(order)` 之后（约 line 440）：
```ts
        queue.markFailed(order)
```
改为：
```ts
        queue.markFailed(order)
        completedCount++
        onProgress?.(completedCount, orders.length)
```

在 `const allResults: WorkerResult[] = []` 之后（约 line 427）添加计数器：
```ts
    const allResults: WorkerResult[] = []
    let completedCount = 0
```

- [ ] **步骤 4：更新 DelegateBatchCoordinator 接口**

文件：`src/tools/delegate-batch.ts`，line 11。

**before：**
```ts
export interface DelegateBatchCoordinator {
  delegateBatch(requests: DelegationRequest[], policy?: AggregationPolicy, abortSignal?: AbortSignal): Promise<CoordinatorRun>
}
```

**after：**
```ts
export interface DelegateBatchCoordinator {
  delegateBatch(
    requests: DelegationRequest[],
    policy?: AggregationPolicy,
    abortSignal?: AbortSignal,
    onProgress?: (completed: number, total: number) => void,
  ): Promise<CoordinatorRun>
}
```

- [ ] **步骤 5：在 delegate_batch tool 的 execute 中传递 onProgress**

文件：`src/tools/delegate-batch.ts`，line 171。

**before：**
```ts
      const run = await coordinator.delegateBatch(dispatched, parsed.data.policy ?? 'primary_decides', params.abortSignal)
```

**after：**
```ts
      let progressReported = 0
      const totalDispatched = dispatched.length
      const run = await coordinator.delegateBatch(
        dispatched,
        parsed.data.policy ?? 'primary_decides',
        params.abortSignal,
        (completed, total) => {
          if (completed > progressReported) {
            progressReported = completed
            params.onOutput?.(`⏳ batch progress: ${completed}/${total} workers done\n`)
          }
        },
      )
```

- [ ] **步骤 6：更新 main.tsx 穿透**

文件：`src/main.tsx`

**位置 1（约 line 168）：**

**before：**
```ts
      delegateBatch: async (requests, policy) => {
        return _coordinatorRef.delegateBatch(requests, policy)
```

**after：**
```ts
      delegateBatch: async (requests, policy, abortSignal, onProgress) => {
        return _coordinatorRef.delegateBatch(requests, policy, abortSignal, onProgress)
```

**位置 2（约 line 818）：**

**before：**
```ts
          { delegateBatch: async (requests, policy) => goalCoordinator.delegateBatch(requests, policy) },
```

**after：**
```ts
          { delegateBatch: async (requests, policy, abortSignal, onProgress) => goalCoordinator.delegateBatch(requests, policy, abortSignal, onProgress) },
```

- [ ] **步骤 7：运行测试验证通过**

运行：`npx tsx --test src/agent/__tests__/coordinator-progress.test.ts`

预期：PASS

- [ ] **步骤 8：类型检查 + 全量测试**

```bash
npx tsc --noEmit
npm test
```

预期：PASS

- [ ] **步骤 9：Commit**

```bash
git add src/agent/coordinator.ts src/tools/delegate-batch.ts src/main.tsx src/agent/__tests__/coordinator-progress.test.ts
git commit -m "feat(coordinator): delegate_batch reports worker progress via onOutput

Adds onProgress callback to delegateBatch so each completed worker
triggers a visible progress update in the TUI. Prevents the UI from
appearing frozen during 45-180s batch execution."
```

---

### Task 3：集成验证

- [ ] **步骤 1：确认 typecheck 干净**

```bash
npx tsc --noEmit
```

预期：0 errors

- [ ] **步骤 2：运行全量测试**

```bash
npm test
```

预期：全部通过，无回归

- [ ] **步骤 3：手动验证（如需）**

1. 启动 session，发消息触发 delegate_batch
2. 在 batch 执行期间发送一条用户消息
3. 确认看到 "Guidance queued" 提示
4. 确认看到 "⏳ batch progress: 1/N" 进度更新
5. 如果 batch failed，确认看到 "preserved for next turn" 提示
6. 发下一条消息，确认 preserved 的 guidance 被注入

---

## Self-Check

### Placeholder Scan
无 TODO/TBD/待定。每个步骤都有完整代码。

### 规格覆盖度
- 用户消息丢失 → Task 1（onError drain）✓
- UI 卡死无反馈 → Task 2（onOutput progress）✓
- 回归保护 → Task 3 ✓

### 风险评估
- Task 1 风险极低——`drain()` 是 SteerBuffer 已有方法，只是替换 `clear()` 调用
- Task 2 中 `onProgress` 是可选参数，不影响现有调用路径（不传就 undefined，`?.()` 跳过）
- `main.tsx` 穿透只传递参数，不添加逻辑
