# Wave 7: Sub-Agent 接线增强 实施计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 把 coordinator 从 demo 级提升到生产级——暴露全部 worker 类型、启用写入工具、claim 回流、并行 delegation、失败升级。

**架构：** 纯接线，不新建架构。修改 delegate-task tool schema + coordinator 工具选择逻辑 + claim 提取 + goal loop 注入。

**技术栈：** TypeScript, 现有 coordinator/work-order/worker-session/claim-store infrastructure

**前置条件：** Wave 6 Goal Loop ✅ + Evolutionary Context Fabric Phase 1 ✅

---

## 文件结构

### 修改文件

| 文件 | 变更 |
|------|------|
| `src/tools/delegate-task.ts` | 暴露 kind/profile 参数 + claim 提取 + isConcurrencySafe |
| `src/agent/coordinator.ts` | 按 profile 选择工具集 + shouldEscalate 接线 + maxWorkers=3 |
| `src/agent/worker-session.ts` | 接受 activeClaims 注入 + write profile maxTurns=8 |
| `src/main.tsx` | runtimeFactory 按 profile 选工具 + goal loop 注入 coordinator |

### 新建文件

| 文件 | 职责 |
|------|------|
| `src/tools/delegate-batch.ts` | delegate_batch 工具：接受 tasks[] 并行执行 |
| `src/__tests__/delegate-task.test.ts` | delegate_task kind/profile + claim 提取测试 |
| `src/__tests__/delegate-batch.test.ts` | delegate_batch 并行 + 聚合测试 |

---

## 任务 1：delegate_task 暴露 kind/profile 参数

**文件：**
- 修改：`src/tools/delegate-task.ts`
- 测试：`src/__tests__/delegate-task.test.ts`

- [ ] **步骤 1：编写失败的测试**

```typescript
// src/__tests__/delegate-task.test.ts
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createDelegateTaskTool } from '../tools/delegate-task.js'
import type { DelegationRequest, CoordinatorRun } from '../agent/coordinator.js'

describe('delegate_task tool', () => {
  it('passes kind and profile from input to coordinator', async () => {
    let captured: DelegationRequest | null = null
    const tool = createDelegateTaskTool({
      delegate: async (req) => {
        captured = req
        return { status: 'completed', results: [], packet: '<worker_results></worker_results>' } as CoordinatorRun
      },
    })

    await tool.execute({
      toolUseId: 'tu-1',
      input: { objective: 'review the auth module for security issues', kind: 'review', profile: 'reviewer' },
      abortSignal: new AbortController().signal,
    })

    assert.equal(captured?.kind, 'review')
    assert.equal(captured?.profile, 'reviewer')
  })

  it('defaults to code_search/code_scout when kind/profile omitted', async () => {
    let captured: DelegationRequest | null = null
    const tool = createDelegateTaskTool({
      delegate: async (req) => {
        captured = req
        return { status: 'completed', results: [], packet: '<worker_results></worker_results>' } as CoordinatorRun
      },
    })

    await tool.execute({
      toolUseId: 'tu-2',
      input: { objective: 'find all usages of parseCliArgs in the codebase' },
      abortSignal: new AbortController().signal,
    })

    assert.equal(captured?.kind, 'code_search')
    assert.equal(captured?.profile, 'code_scout')
  })
})
```

- [ ] **步骤 2：运行测试确认失败**

运行：`npm test -- src/__tests__/delegate-task.test.ts`
预期：FAIL（kind/profile 不从 input 读取）

- [ ] **步骤 3：修改 delegate-task.ts**

```typescript
// src/tools/delegate-task.ts — 修改 input schema 和 execute

const delegateTaskInputSchema = z.object({
  objective: z.string().min(1),
  kind: z.enum(['code_search', 'doc_research', 'plan', 'review', 'verify', 'patch_proposal']).optional(),
  profile: z.enum(['code_scout', 'doc_scout', 'planner', 'reviewer', 'verifier', 'patcher']).optional(),
  files: z.array(z.string()).optional(),
  symbols: z.array(z.string()).optional(),
})

// 在 execute 中：
const run = await coordinator.delegate({
  parentTurnId: params.toolUseId,
  objective: parsed.data.objective,
  kind: parsed.data.kind ?? 'code_search',
  profile: parsed.data.profile ?? 'code_scout',
  scope: {
    files: parsed.data.files,
    symbols: parsed.data.symbols,
  },
})
```

同时更新 `definition.input_schema`：
```typescript
properties: {
  objective: { type: 'string', description: 'Specific objective for the worker.' },
  kind: { type: 'string', enum: ['code_search', 'doc_research', 'plan', 'review', 'verify', 'patch_proposal'], description: 'Worker task type. Default: code_search.' },
  profile: { type: 'string', enum: ['code_scout', 'doc_scout', 'planner', 'reviewer', 'verifier', 'patcher'], description: 'Worker profile. Default: code_scout.' },
  files: { type: 'array', items: { type: 'string' }, description: 'Optional file paths to focus on.' },
  symbols: { type: 'array', items: { type: 'string' }, description: 'Optional symbols to focus on.' },
},
```

更新 description：
```typescript
description: 'Delegate a bounded task to a worker agent. Supports code search, review, planning, verification, and patching.',
```

设置 `isConcurrencySafe: () => true`。

- [ ] **步骤 4：运行测试确认通过**

运行：`npm test -- src/__tests__/delegate-task.test.ts`
预期：PASS

- [ ] **步骤 5：Commit**

```bash
git add src/tools/delegate-task.ts src/__tests__/delegate-task.test.ts
git commit -m "feat(delegate): expose kind/profile params + enable concurrency"
```

---

## 任务 2：Coordinator 按 profile 选择工具集 + 失败升级

**文件：**
- 修改：`src/agent/coordinator.ts`

- [ ] **步骤 1：导入 WRITE_WORKER_TOOLS**

```typescript
import {
  createReadOnlyWorkOrder,
  mapWorkOrderKindToCapabilityTask,
  READ_ONLY_WORKER_TOOLS,
  WRITE_WORKER_TOOLS,
  // ... existing imports
} from './work-order.js'
```

- [ ] **步骤 2：按 profile 选择工具集**

在 `delegate()` 方法中，替换硬编码的 `READ_ONLY_WORKER_TOOLS`：

```typescript
const writeProfiles: WorkerProfile[] = ['patcher', 'verifier']
const toolSet = writeProfiles.includes(request.profile) ? WRITE_WORKER_TOOLS : READ_ONLY_WORKER_TOOLS
const workerRegistry = filterToolRegistry(this.config.baseToolRegistry, toolSet)
```

- [ ] **步骤 3：接线 shouldEscalate**

在 `delegate()` 中，worker 完成后检查升级：

```typescript
this.state.recordEvent({ type: run.result.status === 'passed' ? 'passed' : run.result.status === 'blocked' ? 'blocked' : 'failed', workOrderId: order.id, timestamp: Date.now() })

if (this.state.shouldEscalate()) {
  this.state.recordEvent({ type: 'escalated', workOrderId: order.id, timestamp: Date.now() })
  return {
    status: 'completed',
    order,
    selectedModel: selected.model,
    results: [{ ...run.result, status: 'blocked', summary: `Escalated: ${this.state.getSummary().failed} consecutive failures` }],
    packet: buildPrimaryWorkerPacket([run.result]),
  }
}
```

- [ ] **步骤 4：运行测试**

运行：`npm test`
预期：全部通过

- [ ] **步骤 5：Commit**

```bash
git add src/agent/coordinator.ts
git commit -m "feat(coordinator): profile-based tool selection + failure escalation"
```

---

## 任务 3：Worker 结果 → claim 提取

**文件：**
- 修改：`src/tools/delegate-task.ts`
- 测试：追加到 `src/__tests__/delegate-task.test.ts`

- [ ] **步骤 1：编写失败的测试**

```typescript
// 追加到 src/__tests__/delegate-task.test.ts
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ContextClaimStore } from '../context/claim-store.js'

it('extracts worker findings into claim store', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rivet-delegate-claims-'))
  try {
    const claimStore = new ContextClaimStore(dir, 'session-test')
    const tool = createDelegateTaskTool(
      {
        delegate: async () => ({
          status: 'completed' as const,
          results: [{
            workOrderId: 'wo-1',
            status: 'passed' as const,
            summary: 'Found auth vulnerability',
            findings: ['SQL injection in login handler', 'Missing rate limiting on /api/auth'],
            artifacts: [],
            changedFiles: [],
            risks: [],
            nextActions: [],
            evidenceStatus: 'verified' as const,
          }],
          packet: '<worker_results>...</worker_results>',
        }),
      },
      claimStore,
      'session-test',
    )

    await tool.execute({
      toolUseId: 'tu-3',
      input: { objective: 'review auth module for security issues', kind: 'review', profile: 'reviewer' },
      abortSignal: new AbortController().signal,
    })

    const claims = claimStore.listClaims({ kind: ['worker_finding'] })
    assert.equal(claims.length, 2)
    assert.ok(claims.some(c => c.text.includes('SQL injection')))
    assert.ok(claims.some(c => c.text.includes('rate limiting')))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
```

- [ ] **步骤 2：运行测试确认失败**

运行：`npm test -- src/__tests__/delegate-task.test.ts`
预期：FAIL（createDelegateTaskTool 签名不接受 claimStore）

- [ ] **步骤 3：修改 createDelegateTaskTool 签名**

```typescript
// src/tools/delegate-task.ts
import { type ContextClaimStore } from '../context/claim-store.js'
import { type ClaimProposal } from '../context/claims.js'

export function createDelegateTaskTool(
  coordinator: DelegateTaskCoordinator,
  claimStore?: ContextClaimStore,
  sessionId?: string,
): Tool {
  return {
    // ...existing definition...
    async execute(params: ToolCallParams): Promise<ToolResult> {
      // ...existing parse + delegate logic...

      // Extract worker findings into claim store
      if (claimStore && sessionId && run.status === 'completed') {
        const createdAt = Date.now()
        for (const result of run.results) {
          if (result.status !== 'passed') continue
          for (const finding of result.findings) {
            const proposal: ClaimProposal = {
              kind: 'worker_finding',
              scope: 'session',
              text: finding,
              confidence: 0.75,
              fitness: 4,
              source: { actor: 'worker', sessionId, turn: 0, eventId: `${params.toolUseId}:worker` },
              evidence: [{ id: `${params.toolUseId}:finding`, kind: 'worker', summary: finding, createdAt }],
              createdAt,
              tags: ['worker', result.workOrderId],
            }
            claimStore.propose(proposal)
          }
        }
      }

      return { content: run.packet, uiContent: formatUiContent(run), isError: false }
    },
    // ...rest unchanged...
  }
}
```

- [ ] **步骤 4：更新 main.tsx 中的 createDelegateTaskTool 调用**

```typescript
// src/main.tsx — 在 toolRegistry 初始化中
reg.register(createDelegateTaskTool(
  { delegate: async (request) => { /* existing */ } },
  claimStore,
  sessionId,
))
```

注意：`claimStore` 和 `sessionId` 需要在 `toolRegistry` 初始化时可用。由于 `toolRegistry` 在 `useState` 中创建（只执行一次），而 `claimStore` 也在 `useState` 中创建，需要用 module-level ref 模式（与 `_coordinatorRef` 相同）。

```typescript
let _claimStoreRef: ContextClaimStore | null = null
let _sessionIdRef: string | null = null

// 在 Root 中：
_claimStoreRef = claimStore
_sessionIdRef = persist.sessionId

// 在 toolRegistry 初始化中：
reg.register(createDelegateTaskTool(
  { delegate: async (request) => { ... } },
  { get store() { return _claimStoreRef ?? undefined }, get sessionId() { return _sessionIdRef ?? undefined } },
))
```

实际实现时简化为：`createDelegateTaskTool` 接受 getter 函数而非直接引用：

```typescript
export function createDelegateTaskTool(
  coordinator: DelegateTaskCoordinator,
  getClaimStore?: () => ContextClaimStore | undefined,
  getSessionId?: () => string | undefined,
): Tool
```

- [ ] **步骤 5：运行测试确认通过**

运行：`npm test -- src/__tests__/delegate-task.test.ts`
预期：PASS

- [ ] **步骤 6：运行全量测试**

运行：`npm test`
预期：全部通过

- [ ] **步骤 7：Commit**

```bash
git add src/tools/delegate-task.ts src/__tests__/delegate-task.test.ts src/main.tsx
git commit -m "feat(delegate): extract worker findings into claim store"
```

---

## 任务 4：Worker 继承父 active claims

**文件：**
- 修改：`src/agent/worker-session.ts`
- 修改：`src/main.tsx`（runtimeFactory）

- [ ] **步骤 1：扩展 WorkerSessionConfig**

```typescript
// src/agent/worker-session.ts — 在 WorkerSessionConfig 中增加
export interface WorkerSessionConfig {
  // ...existing fields...
  activeClaims?: import('../context/claims.js').ContextClaim[]
}
```

- [ ] **步骤 2：在 runWorkerSession 中注入 claims**

```typescript
// src/agent/worker-session.ts — 在 agent 创建后
if (config.activeClaims && config.activeClaims.length > 0) {
  config.promptEngine.updateActiveClaims(config.activeClaims)
}
```

- [ ] **步骤 3：在 runtimeFactory 中传入 active claims**

```typescript
// src/main.tsx — runtimeFactory 修改
const runtimeFactory: WorkerRuntimeFactory = (_order, card, workerRegistry) => ({
  // ...existing fields...
  activeClaims: _claimStoreRef?.listActiveClaims() ?? [],
})
```

- [ ] **步骤 4：运行测试**

运行：`npm test`
预期：全部通过

- [ ] **步骤 5：Commit**

```bash
git add src/agent/worker-session.ts src/main.tsx
git commit -m "feat(worker): inherit parent active claims as read-only context"
```

---

## 任务 5：Goal loop 注入 coordinator

**文件：**
- 修改：`src/main.tsx`（goal loop 的 createAgent）

- [ ] **步骤 1：在 goal loop createAgent 中注册 delegate_task**

```typescript
// src/main.tsx — goal loop 的 createAgent 内
const toolRegistry = createDefaultToolRegistry()

// 创建 coordinator for goal loop
const goalCoordinator = new DelegationCoordinator({
  baseToolRegistry: toolRegistry,
  modelCards: [{ model: model.id, toolUseReliability: 0.8, jsonStability: 0.8, editSuccessRate: 0.7, testRepairRate: 0.6, contextWindow: model.contextWindow, cacheEconomics: 'strong', recommendedTasks: ['code_search'] }],
  maxWorkers: 2,
  runtimeFactory: (order, card, workerRegistry) => ({
    order,
    client: createDeepSeekClient({ apiKey: key, model: card.model, reasoningEffort: undefined, maxTokens: Math.min(4096, card.contextWindow), thinkingBudget: 4096 }),
    promptEngine: new PromptEngine({ model: card.model, maxTokens: 4096, staticCtx: { tools: workerRegistry.getDefinitions() }, volatileCtx: { cwd: process.cwd() } }),
    toolRegistry: workerRegistry,
    cwd: process.cwd(),
    maxTurns: 4,
    contextWindow: card.contextWindow,
    compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' },
    activeClaims: claimStore.listActiveClaims(),
  }),
})

toolRegistry.register(createDelegateTaskTool(
  { delegate: async (req) => goalCoordinator.delegate(req) },
  () => claimStore,
  () => sessionId,
))
```

- [ ] **步骤 2：运行 typecheck**

运行：`npx tsc --noEmit`
预期：无新错误

- [ ] **步骤 3：运行测试**

运行：`npm test`
预期：全部通过

- [ ] **步骤 4：Commit**

```bash
git add src/main.tsx
git commit -m "feat(goal): inject coordinator + delegate_task into goal loop"
```

---

## 任务 6：delegate_batch 工具

**文件：**
- 创建：`src/tools/delegate-batch.ts`
- 创建：`src/__tests__/delegate-batch.test.ts`
- 修改：`src/main.tsx`（注册）

- [ ] **步骤 1：编写失败的测试**

```typescript
// src/__tests__/delegate-batch.test.ts
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createDelegateBatchTool } from '../tools/delegate-batch.js'
import type { CoordinatorRun, DelegationRequest } from '../agent/coordinator.js'

describe('delegate_batch tool', () => {
  it('delegates multiple tasks and returns combined packet', async () => {
    let batchCaptured: DelegationRequest[] = []
    const tool = createDelegateBatchTool({
      delegateBatch: async (requests, _policy) => {
        batchCaptured = requests
        return {
          status: 'completed' as const,
          results: requests.map((_, i) => ({
            workOrderId: `wo-${i}`,
            status: 'passed' as const,
            summary: `Task ${i} done`,
            findings: [`finding-${i}`],
            artifacts: [],
            changedFiles: [],
            risks: [],
            nextActions: [],
            evidenceStatus: 'verified' as const,
          })),
          packet: '<worker_results>batch done</worker_results>',
        } as CoordinatorRun
      },
    })

    const result = await tool.execute({
      toolUseId: 'tu-batch-1',
      input: {
        tasks: [
          { objective: 'search for auth patterns in src/agent', kind: 'code_search' },
          { objective: 'review error handling in src/tools', kind: 'review', profile: 'reviewer' },
        ],
      },
      abortSignal: new AbortController().signal,
    })

    assert.equal(batchCaptured.length, 2)
    assert.equal(batchCaptured[0]?.kind, 'code_search')
    assert.equal(batchCaptured[1]?.kind, 'review')
    assert.equal(result.isError, false)
  })
})
```

- [ ] **步骤 2：运行测试确认失败**

运行：`npm test -- src/__tests__/delegate-batch.test.ts`
预期：FAIL（模块不存在）

- [ ] **步骤 3：实现 delegate-batch.ts**

```typescript
// src/tools/delegate-batch.ts
import { z } from 'zod'
import type { CoordinatorRun, DelegationRequest } from '../agent/coordinator.js'
import type { AggregationPolicy } from '../agent/work-order.js'
import type { Tool, ToolCallParams, ToolResult } from './types.js'

export interface DelegateBatchCoordinator {
  delegateBatch(requests: DelegationRequest[], policy?: AggregationPolicy): Promise<CoordinatorRun>
}

const taskSchema = z.object({
  objective: z.string().min(1),
  kind: z.enum(['code_search', 'doc_research', 'plan', 'review', 'verify', 'patch_proposal']).optional(),
  profile: z.enum(['code_scout', 'doc_scout', 'planner', 'reviewer', 'verifier', 'patcher']).optional(),
  files: z.array(z.string()).optional(),
  symbols: z.array(z.string()).optional(),
})

const inputSchema = z.object({
  tasks: z.array(taskSchema).min(1).max(5),
  policy: z.enum(['all_required', 'first_success', 'majority', 'primary_decides']).optional(),
})

export function createDelegateBatchTool(coordinator: DelegateBatchCoordinator): Tool {
  return {
    definition: {
      name: 'delegate_batch',
      description: 'Run multiple worker tasks in parallel. Max 5 tasks per batch.',
      input_schema: {
        type: 'object',
        properties: {
          tasks: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                objective: { type: 'string' },
                kind: { type: 'string', enum: ['code_search', 'doc_research', 'plan', 'review', 'verify', 'patch_proposal'] },
                profile: { type: 'string', enum: ['code_scout', 'doc_scout', 'planner', 'reviewer', 'verifier', 'patcher'] },
                files: { type: 'array', items: { type: 'string' } },
                symbols: { type: 'array', items: { type: 'string' } },
              },
              required: ['objective'],
            },
            description: 'Array of tasks to run in parallel (max 5).',
          },
          policy: { type: 'string', enum: ['all_required', 'first_success', 'majority', 'primary_decides'], description: 'Aggregation policy. Default: primary_decides.' },
        },
        required: ['tasks'],
      },
    },
    async execute(params: ToolCallParams): Promise<ToolResult> {
      const parsed = inputSchema.safeParse(params.input)
      if (!parsed.success) return { content: `Invalid input: ${parsed.error.message}`, isError: true }

      const requests: DelegationRequest[] = parsed.data.tasks.map((t, i) => ({
        parentTurnId: `${params.toolUseId}:${i}`,
        objective: t.objective,
        kind: t.kind ?? 'code_search',
        profile: t.profile ?? 'code_scout',
        scope: { files: t.files, symbols: t.symbols },
      }))

      const run = await coordinator.delegateBatch(requests, parsed.data.policy ?? 'primary_decides')
      const passed = run.results.filter(r => r.status === 'passed').length
      return {
        content: run.packet,
        uiContent: `delegate_batch: ${passed}/${run.results.length} passed`,
        isError: false,
      }
    },
    requiresApproval: () => false,
    isConcurrencySafe: () => false,
    isEnabled: () => true,
  }
}
```

- [ ] **步骤 4：注册到 main.tsx**

```typescript
// src/main.tsx — 在 toolRegistry 初始化中，delegate_task 注册之后
import { createDelegateBatchTool } from './tools/delegate-batch.js'

reg.register(createDelegateBatchTool({
  delegateBatch: async (requests, policy) => {
    if (!_coordinatorRef) throw new Error('DelegationCoordinator not initialized')
    return _coordinatorRef.delegateBatch(requests, policy)
  },
}))
```

- [ ] **步骤 5：运行测试确认通过**

运行：`npm test`
预期：全部通过

- [ ] **步骤 6：Commit**

```bash
git add src/tools/delegate-batch.ts src/__tests__/delegate-batch.test.ts src/main.tsx
git commit -m "feat(delegate): delegate_batch tool for parallel worker execution"
```

---

## 任务 7：maxWorkers 提升 + runtimeFactory 按 profile 调整

**文件：**
- 修改：`src/main.tsx`

- [ ] **步骤 1：maxWorkers 从 2 提升到 3**

```typescript
// src/main.tsx — DelegationCoordinator 配置
_coordinatorRef = new DelegationCoordinator({
  baseToolRegistry: toolRegistry,
  modelCards,
  maxWorkers: 3,
  runtimeFactory,
})
```

- [ ] **步骤 2：runtimeFactory 按 profile 调整 maxTurns**

```typescript
const runtimeFactory: WorkerRuntimeFactory = (order, card, workerRegistry) => {
  const writeProfiles = ['patcher', 'verifier']
  const isWrite = writeProfiles.includes(order.profile)
  return {
    order,
    client: createDeepSeekClient({
      apiKey,
      model: card.model,
      reasoningEffort: undefined,
      maxTokens: isWrite ? Math.min(8192, card.contextWindow) : Math.min(4096, card.contextWindow),
      thinkingBudget: isWrite ? 8192 : 4096,
    }),
    promptEngine: new PromptEngine({
      model: card.model,
      maxTokens: isWrite ? 8192 : 4096,
      staticCtx: { tools: workerRegistry.getDefinitions() },
      volatileCtx: { cwd, sessionMemoryBlock: persist.buildMemoryBlock() },
    }),
    toolRegistry: workerRegistry,
    cwd,
    maxTurns: isWrite ? 8 : 4,
    contextWindow: card.contextWindow,
    compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' },
    activeClaims: _claimStoreRef?.listActiveClaims() ?? [],
  }
}
```

- [ ] **步骤 3：运行 typecheck + test**

运行：`npx tsc --noEmit && npm test`
预期：无错误，全部通过

- [ ] **步骤 4：Commit**

```bash
git add src/main.tsx
git commit -m "feat(coordinator): maxWorkers=3 + write profiles get 8 turns and larger budget"
```

---

## 验收标准

| 标准 | 验证方法 |
|------|---------|
| delegate_task 接受 kind/profile 参数 | 测试：传入 review/reviewer → coordinator 收到 |
| patcher worker 有写入工具 | coordinator 按 profile 选 WRITE_WORKER_TOOLS |
| Worker findings 进入 claim store | 测试：delegate 后 listClaims 含 worker_finding |
| Goal loop 可 delegate | goal loop createAgent 注册了 delegate_task |
| delegate_batch 并行执行 | 测试：传入 2 tasks → 并行完成 |
| Worker 看到父 claims | worker promptEngine 含 activeClaims |
| 连续失败触发升级 | coordinator shouldEscalate 被调用 |
| 所有测试通过 | npm test: 770+ pass, 0 fail |
