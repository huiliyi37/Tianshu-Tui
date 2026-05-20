# 三权协程调度 — 扩展实现计划 v2

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 在现有 DelegationCoordinator + WorkOrderQueue + WorkerSession 基础上扩展，实现领域轴分解 + 行为轴叠加 + TaskBoard 读投影层。不重建调度基础设施，只扩展。

**架构：** WorkOrderQueue 加事件系统 + domain 标签（替代独立 TaskBoard）。StarDomain 扩展 toolWhitelist + systemPromptSuffix（替代独立 DOMAIN_WORKER_CONFIGS）。Dispatcher Hook 生成 DelegationRequest[] 喂入现有 coordinator（替代独立 Scheduler）。TaskBoard 只做读投影层给 TUI 用。

**技术栈：** TypeScript strict, node:test + assert/strict, Zod, 现有 DelegationCoordinator/WorkOrderQueue/WorkerSession/HandsSession

---

## 设计修正记录

本计划 v2 修正了 v1 的 3 个设计缺陷：

| 缺陷 | v1 方案 | v2 修正 |
|------|---------|---------|
| decomposeByDomain 串行化依赖链 | frontend→backend→tools 按域顺序串行 | 基于数据流：只有存在文件/符号依赖时才建边，同级域并行 |
| classifyFile 遗漏 prompt/config | src/prompt/ fallback 到 'backend' | 新增 'prompt' 域，扩展 'config' 匹配 |
| runDomainWorker 绕过模型路由 | 用 createAgent callback | 通过 coordinator.delegate() 走现有 ModelCapabilityCard + ProviderHealthTracker 路由 |

---

## 现有基础设施（直接复用，不重建）

| 组件 | 文件 | 行数 | 本次扩展 |
|------|------|------|----------|
| DelegationCoordinator | `coordinator.ts` | ~280 | 无需修改，Dispatcher Hook 直接调用 `delegate()` |
| WorkOrderQueue | `work-queue.ts` | ~80 | 加事件系统 + domain 标签 + 文件冲突检测 |
| WorkOrder schema | `work-order.ts` | ~350 | 加 `domain?` 可选字段 |
| WorkerSession | `worker-session.ts` | ~150 | 无需修改 |
| HandsSession | `hands-session.ts` | ~120 | 无需修改 |
| CoordinatorState | `coordinator-state.ts` | ~80 | 无需修改 |
| StarDomain | `star-domain.ts` | ~80 | 扩展 toolWhitelist + systemPromptSuffix |
| coordination-policy | `coordination-policy.ts` | ~50 | 扩展 authority 映射 |
| TaskContract | `task-contract.ts` | ~140 | 无需修改 |
| StigmergyStore | `stigmergy.ts` | ~170 | 无需修改 |

---

## File Structure

### 修改文件

| 文件 | 修改内容 |
|------|----------|
| `src/agent/work-order.ts` | `workOrderSchema` 加 `domain?: DomainArea` 可选字段 |
| `src/agent/work-queue.ts` | 加 `onEvent` 回调 + `hasFileConflict()` + domain 标签存储 |
| `src/agent/star-domain.ts` | `StarDomain` 接口加 `toolWhitelist` + `systemPromptSuffix` |
| `src/agent/worker-prompts.ts` | `buildWorkerPrompt()` 支持 `authoritySuffix` 参数 |
| `src/agent/work-queue.ts` | 加 `inFlightOrders` Map 追踪执行中任务（用于文件冲突检测） |

### 新建文件

| 文件 | 职责 |
|------|------|
| `src/agent/dispatcher.ts` | `classifyFile()` + `decomposeByDataContract()` — 基于数据流的领域分解 |
| `src/agent/task-board.ts` | 纯读投影层 — 从 WorkOrderQueue 事件构建面向 TUI 的任务视图 |
| `src/agent/hooks/dispatcher-hook.ts` | RuntimeHook 钩子 — TaskContract → DelegationRequest[] → coordinator.delegate() |
| `src/agent/__tests__/dispatcher.test.ts` | 领域分解 + 数据流依赖测试 |
| `src/agent/__tests__/task-board.test.ts` | 读投影层测试 |
| `src/agent/__tests__/dispatcher-hook.test.ts` | Hook 集成测试 |

---

## Tasks

### Task 1: WorkOrder 扩展 domain 字段

**目标：** 最小侵入式扩展，零破坏性。

#### Step 1.1: 添加 DomainArea 类型

- [ ] **修改** `src/agent/work-order.ts`

在 `workOrderKindSchema` 之前添加：

```typescript
export const domainAreaSchema = z.enum([
  'frontend',   // src/tui/
  'backend',    // src/agent/, src/api/, src/compact/, src/context/
  'prompt',     // src/prompt/（核心 prompt 工程）
  'tools',      // src/tools/
  'config',     // src/config/
  'docs',       // docs/
  'tests',      // *.test.ts, *.spec.ts
])
export type DomainArea = z.infer<typeof domainAreaSchema>
```

#### Step 1.2: 扩展 workOrderSchema

- [ ] **修改** `src/agent/work-order.ts:workOrderSchema`

在现有字段末尾添加可选字段（向后兼容，现有代码无需改动）：

```typescript
domain: domainAreaSchema.optional(),
```

#### Step 1.3: 测试

- [ ] **修改** `src/agent/__tests__/work-order.test.ts`

添加：
1. `createReadOnlyWorkOrder` 无 domain 时 schema 校验通过
2. `createReadOnlyWorkOrder` 有 domain='frontend' 时正确写入
3. Zod parse 不含 domain 的旧格式 WorkOrder 仍然通过

**运行：** `./node_modules/.bin/tsx --test src/agent/__tests__/work-order.test.ts`
**预期：** 所有测试通过。
**提交：** `feat(agent): extend WorkOrder with optional domain field — backward compatible`

---

### Task 2: StarDomain 扩展 toolWhitelist + systemPromptSuffix

**目标：** 复用现有三权域定义，添加 worker 执行时需要的配置。

#### Step 2.1: 扩展 StarDomain 接口

- [ ] **修改** `src/agent/star-domain.ts`

在 `StarDomain` 接口中添加：

```typescript
export interface StarDomain {
  id: StarDomainId
  name: string
  motto: string
  volatileBlock: string
  decisionStyle: DecisionStyle
  courageThreshold: number
  keywords: string[]
  isCustom: boolean
  /** Worker 执行时允许的工具白名单 */
  toolWhitelist: readonly string[]
  /** Worker system prompt 末尾追加的权域指令 */
  systemPromptSuffix: string
}
```

#### Step 2.2: 填充三个域的配置

- [ ] **修改** `src/agent/star-domain.ts:STAR_DOMAINS`

```typescript
pojun: {
  // ... 现有字段不变 ...
  toolWhitelist: ['read_file', 'write_file', 'edit_file', 'bash', 'grep', 'glob', 'diff', 'run_tests', 'inspect_project', 'repo_map', 'related_tests'],
  systemPromptSuffix: '你是破军——探索者。大胆尝试，容忍失败，追求突破。遇到不确定的路径时，倾向于探索而非保守。',
},
tianfu: {
  // ... 现有字段不变 ...
  toolWhitelist: ['read_file', 'grep', 'glob', 'diff', 'inspect_project', 'repo_map', 'related_tests'],
  systemPromptSuffix: '你是天府——守护者。评估风险，保护资产，谨慎决策。在修改代码前先充分理解现有结构。',
},
tianliang: {
  // ... 现有字段不变 ...
  toolWhitelist: ['read_file', 'write_file', 'edit_file', 'bash', 'grep', 'glob', 'diff', 'run_tests', 'inspect_project', 'repo_map', 'related_tests'],
  systemPromptSuffix: '你是天梁——执行者。严格按计划，精确交付，不妥协质量。每一步都要有验证。',
},
```

#### Step 2.3: 测试

- [ ] **修改** `src/agent/__tests__/star-domain.test.ts`（如果存在）或创建

添加：
1. `STAR_DOMAINS.pojun.toolWhitelist` 包含 write_file
2. `STAR_DOMAINS.tianfu.toolWhitelist` 不包含 write_file（只读）
3. `STAR_DOMAINS.tianliang.systemPromptSuffix` 包含 '精确交付'
4. `matchDomain` 返回的域有 toolWhitelist

**运行：** `./node_modules/.bin/tsx --test src/agent/__tests__/star-domain.test.ts`
**预期：** 所有测试通过。
**提交：** `feat(agent): extend StarDomain with toolWhitelist + systemPromptSuffix for worker execution`

---

### Task 3: WorkOrderQueue 事件系统 + 文件冲突检测

**目标：** 让队列可观察（事件），并防止并发 worker 修改同一文件。

#### Step 3.1: 事件系统

- [ ] **修改** `src/agent/work-queue.ts`

```typescript
export type QueueEvent =
  | { type: 'enqueued'; order: WorkOrder }
  | { type: 'dequeued'; order: WorkOrder }
  | { type: 'completed'; orderId: string }
  | { type: 'failed'; orderId: string }

export class WorkOrderQueue {
  // ... 现有字段 ...
  private listeners: Array<(event: QueueEvent) => void> = []

  on(listener: (event: QueueEvent) => void): () => void {
    this.listeners.push(listener)
    return () => { this.listeners = this.listeners.filter(l => l !== listener) }
  }

  private emit(event: QueueEvent): void {
    for (const l of this.listeners) l(event)
  }

  enqueue(order: WorkOrder, priority = 0): boolean {
    // ... 现有逻辑 ...
    if (result) this.emit({ type: 'enqueued', order })
    return result
  }

  dequeue(): WorkOrder | undefined {
    // ... 现有逻辑 ...
    if (order) this.emit({ type: 'dequeued', order })
    return order
  }

  markCompleted(order: { id: string; dedupeKey?: string }): void {
    // ... 现有逻辑 ...
    this.emit({ type: 'completed', orderId: order.id })
  }

  markFailed(order: WorkOrder): void {
    // ... 现有逻辑 ...
    this.emit({ type: 'failed', orderId: order.id })
  }
}
```

#### Step 3.2: 文件冲突检测

- [ ] **修改** `src/agent/work-queue.ts`

添加 in-flight 订单追踪（dequeue 会把 order 从 entries 移除，所以需要单独追踪）：

```typescript
private inFlightOrders = new Map<string, WorkOrder>()

/** 检查 order 是否与 in-flight 任务有文件冲突 */
hasFileConflict(order: WorkOrder): boolean {
  if (!order.scope.files?.length) return false
  const orderFiles = new Set(order.scope.files)
  for (const inflight of this.inFlightOrders.values()) {
    if (!inflight.scope.files?.length) continue
    if (inflight.scope.files.some(f => orderFiles.has(f))) return true
  }
  return false
}
```

修改 `markInFlight` / `markCompleted` / `markFailed` 维护 inFlightOrders：

```typescript
markInFlight(order: WorkOrder): void {
  this.inFlightKeys.add(order.dedupeKey)
  this.inFlightOrders.set(order.id, order)
}

markCompleted(order: { id: string; dedupeKey?: string }): void {
  this.completedIds.add(order.id)
  if (order.dedupeKey) this.inFlightKeys.delete(order.dedupeKey)
  this.inFlightOrders.delete(order.id)
  this.emit({ type: 'completed', orderId: order.id })
}

markFailed(order: WorkOrder): void {
  this.inFlightKeys.delete(order.dedupeKey)
  this.inFlightOrders.delete(order.id)
  this.emit({ type: 'failed', orderId: order.id })
}
```

在 `dequeue()` 的 `findIndex` 回调中，依赖检查之后加入：

```typescript
if (this.hasFileConflict(e.order)) return false
```

#### Step 3.3: 测试

- [ ] **修改** `src/agent/__tests__/work-queue.test.ts`

添加：
1. `on()` 收到 enqueued/dequeued/completed/failed 事件
2. `on()` 返回 unsubscribe 函数
3. `hasFileConflict` 检测 in-flight 任务的共享文件
4. `hasFileConflict` 无文件时返回 false
5. `dequeue` 跳过有文件冲突的任务

**运行：** `./node_modules/.bin/tsx --test src/agent/__tests__/work-queue.test.ts`
**预期：** 所有测试通过。
**提交：** `feat(agent): add event system + file conflict detection to WorkOrderQueue`

---

### Task 4: Dispatcher — 基于数据流的领域分解

**目标：** 从 TaskContract 按文件路径分类领域，基于数据流（而非域顺序）建立依赖。

#### Step 4.1: classifyFile

- [ ] **创建** `src/agent/dispatcher.ts`

```typescript
import type { DomainArea } from './work-order.js'

export function classifyFile(path: string): DomainArea {
  if (/src\/tui\//.test(path)) return 'frontend'
  if (/src\/prompt\//.test(path)) return 'prompt'
  if (/src\/config\//.test(path)) return 'config'
  if (/src\/tools\//.test(path)) return 'tools'
  if (/docs\//.test(path)) return 'docs'
  if (/\.(test|spec)\./.test(path)) return 'tests'
  // src/agent/, src/api/, src/compact/, src/context/
  return 'backend'
}
```

#### Step 4.2: 基于数据流的依赖分析

- [ ] **修改** `src/agent/dispatcher.ts`

关键修正：**不按域顺序串行化依赖，而是基于文件间的数据流建立依赖边。**

```typescript
import type { WorkOrderScope, DomainArea } from './work-order.js'
import type { StarDomainId } from './star-domain.js'
import type { TaskContract } from '../context/task-contract.js'
import { matchDomain } from './star-domain.js'

export interface DecomposedTask {
  title: string
  objective: string
  domain: DomainArea
  authority: StarDomainId  // 复用现有 StarDomainId，不引入新类型
  dependsOn: number[]  // 同一 decompose 调用内的 index
  scope: WorkOrderScope
}

/**
 * 基于数据流的依赖分析。
 *
 * 规则：
 * 1. tests 域依赖它测试的源文件所在域
 * 2. 同域内的任务按文件修改顺序排列
 * 3. 不同域之间如果没有文件/符号引用关系，则并行
 *
 * 例：用户说 "重构 auth 模块并添加测试"
 * 文件：src/agent/auth.ts, src/tui/login.tsx, src/agent/__tests__/auth.test.ts
 *
 * T0 [backend] 重构 auth.ts         → 无依赖
 * T1 [frontend] 更新 login.tsx       → 无依赖（与 T0 并行！）
 * T2 [tests] 编写 auth.test.ts       → 依赖 T0（测试被测模块）
 */
export function decomposeByDataContract(contract: TaskContract): DecomposedTask[] {
  const files = contract.scope.mentionedFiles
  if (files.length === 0) {
    return [{
      title: contract.objective.slice(0, 60),
      objective: contract.objective,
      domain: 'backend',
      authority: matchDomain(contract.objective) ?? 'tianliang',
      dependsOn: [],
      scope: { files: [] },
    }]
  }

  // 按域分组
  const groups = new Map<DomainArea, string[]>()
  for (const file of files) {
    const area = classifyFile(file)
    const list = groups.get(area) ?? []
    list.push(file)
    groups.set(area, list)
  }

  // 为每个域生成任务
  const tasks: DecomposedTask[] = []
  const domainIndex = new Map<DomainArea, number>()  // 域 → 任务 index

  for (const [domain, domainFiles] of groups) {
    const objective = `处理 ${domain} 域: ${domainFiles.join(', ')}`
    tasks.push({
      title: `[${domain}] ${contract.objective.slice(0, 40)}`,
      objective,
      domain,
      authority: matchDomain(objective) ?? 'tianliang',
      dependsOn: [],
      scope: { files: domainFiles },
    })
    domainIndex.set(domain, tasks.length - 1)
  }

  // 基于数据流建依赖边
  // 规则：tests 依赖被测源文件所在域
  const testIdx = domainIndex.get('tests')
  if (testIdx !== undefined) {
    const testFiles = groups.get('tests') ?? []
    for (const [domain, idx] of domainIndex) {
      if (domain === 'tests') continue
      // 如果测试文件名包含源文件所在域的路径片段，建立依赖
      const domainFiles = groups.get(domain) ?? []
      const hasLink = testFiles.some(tf =>
        domainFiles.some(df => tf.includes(df.replace(/\.\w+$/, '')))
      )
      if (hasLink) {
        tasks[testIdx]!.dependsOn.push(idx)
      }
    }
  }

  return tasks
}
```

#### Step 4.3: 测试

- [ ] **创建** `src/agent/__tests__/dispatcher.test.ts`

测试用例：
1. `classifyFile` → 'frontend' (src/tui/app.tsx)
2. `classifyFile` → 'prompt' (src/prompt/engine.ts) — **修正 v1 遗漏**
3. `classifyFile` → 'config' (src/config/schema.ts) — **修正 v1 遗漏**
4. `classifyFile` → 'tools' (src/tools/grep.ts)
5. `classifyFile` → 'backend' (src/agent/loop.ts)
6. `classifyFile` → 'tests' (src/agent/__tests__/loop.test.ts)
7. `decomposeByDataContract` 无文件 → 单任务
8. `decomposeByDataContract` 多域文件 → 多任务
9. `decomposeByDataContract` tests 域依赖源文件域 — **数据流依赖**
10. `decomposeByDataContract` 无引用关系的域并行（dependsOn 为空）

**运行：** `./node_modules/.bin/tsx --test src/agent/__tests__/dispatcher.test.ts`
**预期：** 10 tests, 0 failures.
**提交：** `feat(agent): add Dispatcher — data-flow-based domain decomposition`

---

### Task 5: Dispatcher Hook — 喂入现有 Coordinator

**目标：** 在 RuntimeHookPipeline 中自动从 TaskContract 分解，通过 coordinator.delegate() 执行。

#### Step 5.1: createDispatcherHook

- [ ] **创建** `src/agent/hooks/dispatcher-hook.ts`

关键修正：**不创建独立 Scheduler，而是生成 DelegationRequest[] 喂入现有 coordinator.delegate()。**

```typescript
import type { AfterPerceptionRuntimeHook } from '../runtime-hooks.js'
import type { TaskBoard } from '../task-board.js'
import type { TaskContract } from '../../context/task-contract.js'
import type { Sensorium } from '../sensorium.js'
import type { DelegationCoordinator, DelegationRequest } from '../coordinator.js'
import type { WorkOrderKind, WorkerProfile } from '../work-order.js'
import { decomposeByDataContract } from '../dispatcher.js'
import { matchDomain, type StarDomainId } from '../star-domain.js'

export interface DispatcherHookDeps {
  coordinator: DelegationCoordinator
  board: TaskBoard  // 读投影层，通过 queue 事件自动更新
  getTaskContract: () => TaskContract | undefined
  getSensorium: () => Sensorium | null
  complexityThreshold?: number
}

export function createDispatcherHook(deps: DispatcherHookDeps): AfterPerceptionRuntimeHook {
  let dispatched = false

  return {
    phase: 'afterPerception',
    name: 'task-dispatcher',
    async run(ctx) {
      if (dispatched) return

      const contract = deps.getTaskContract()
      if (!contract || !contract.isActionable) return

      const sensorium = deps.getSensorium()
      const threshold = deps.complexityThreshold ?? 0.3
      if (sensorium && sensorium.complexity < threshold) return

      const subtasks = decomposeByDataContract(contract)
      if (subtasks.length <= 1) return

      // 转换为 DelegationRequest[]，喂入现有 coordinator
      const requests: DelegationRequest[] = subtasks.map(st => ({
        parentTurnId: `dispatcher-${contract.id}`,
        objective: st.objective,
        kind: inferWorkOrderKind(st),
        profile: inferWorkerProfile(st),
        scope: st.scope,
      }))

      // 通过现有 coordinator 执行（复用模型路由、工具过滤、session 隔离）
      // TaskBoard 不需要手动更新 —— coordinator 内部的 WorkOrderQueue
      // 会 emit enqueued/dequeued/completed/failed 事件，TaskBoard 自动接收。
      for (const req of requests) {
        deps.coordinator.delegate(req).catch(error => {
          // 错误已由 coordinator 内部的 queue.markFailed 处理
          // TaskBoard 通过 queue 事件自动更新为 failed 状态
          const msg = error instanceof Error ? error.message : String(error)
          ctx.effects.emitPhaseChange('worker-failed', { reason: msg })
        })
      }

      dispatched = true
      ctx.effects.emitPhaseChange('task-decomposed', {
        reason: `${subtasks.length} subtasks by data-flow analysis`,
        suggestion: subtasks.map(t => `${t.domain}:${t.authority}`).join(', '),
      })
    },
  }
}

function inferWorkOrderKind(st: { domain: DomainArea }): WorkOrderKind {
  if (st.domain === 'tests') return 'verify'
  if (st.domain === 'docs') return 'doc_research'
  // frontend/backend/tools/config 都可能需要修改代码
  return 'patch_proposal'
}

function inferWorkerProfile(st: { domain: DomainArea }): WorkerProfile {
  if (st.domain === 'tests') return 'verifier'
  if (st.domain === 'docs') return 'doc_scout'
  return 'code_scout'
}
```

#### Step 5.2: worker-prompts authority suffix

- [ ] **修改** `src/agent/worker-prompts.ts:buildWorkerPrompt()`

在函数签名中添加可选参数，在 prompt 末尾追加：

```typescript
export function buildWorkerPrompt(
  order: WorkOrder,
  knowledgeBlock?: string,
  authoritySuffix?: string,  // 新增
): string {
  // ... 现有逻辑 ...
  if (authoritySuffix) {
    parts.push('', '## 权域指令', '', authoritySuffix)
  }
  return parts.join('\n')
}
```

#### Step 5.3: 测试

- [ ] **创建** `src/agent/__tests__/dispatcher-hook.test.ts`

测试用例：
1. 无 contract 时不执行
2. isActionable=false 时不执行
3. complexity < threshold 时不执行
4. 单文件任务不分解
5. 多域文件任务调用 coordinator.delegate() 多次
6. 每次 run() 只执行一次
7. emitPhaseChange 被调用

**运行：** `./node_modules/.bin/tsx --test src/agent/__tests__/dispatcher-hook.test.ts`
**预期：** 7 tests, 0 failures.
**提交：** `feat(agent): add Dispatcher Hook — TaskContract decomposition via existing coordinator`

---

### Task 6: TaskBoard 读投影层

**目标：** 从 WorkOrderQueue 事件构建面向 TUI 的任务视图。只读，不做调度。

#### Step 6.1: TaskBoard 实现

- [ ] **创建** `src/agent/task-board.ts`

```typescript
import type { DomainArea, WorkOrder, WorkerResult } from './work-order.js'
import type { WorkOrderQueue, QueueEvent } from './work-queue.js'

export type BoardTaskStatus = 'pending' | 'running' | 'completed' | 'failed'

export interface BoardTask {
  id: string
  seq: number
  title: string
  objective: string
  domain: DomainArea
  status: BoardTaskStatus
  dependsOn: string[]
  scope: { files: string[] }
  result?: WorkerResult
  startedAt?: number
  completedAt?: number
}

export type BoardEvent =
  | { type: 'task:added'; task: BoardTask }
  | { type: 'task:started'; taskId: string }
  | { type: 'task:completed'; taskId: string }
  | { type: 'task:failed'; taskId: string }

/**
 * TaskBoard — 纯读投影层。
 * 监听 WorkOrderQueue 事件，构建面向 TUI 的任务视图。
 * 不做调度，不做决策，只提供查询接口。
 */
export class TaskBoard {
  private tasks = new Map<string, BoardTask>()
  private seq = 0
  private listeners: Array<(event: BoardEvent) => void> = []

  constructor(queue: WorkOrderQueue) {
    queue.on(event => this.handleQueueEvent(event))
  }

  private handleQueueEvent(event: QueueEvent): void {
    switch (event.type) {
      case 'enqueued': {
        const task: BoardTask = {
          id: event.order.id,
          seq: ++this.seq,
          title: event.order.objective.slice(0, 60),
          objective: event.order.objective,
          domain: event.order.domain ?? 'backend',
          status: 'pending',
          dependsOn: event.order.dependencies,
          scope: { files: event.order.scope.files ?? [] },
        }
        this.tasks.set(task.id, task)
        this.emit({ type: 'task:added', task })
        break
      }
      case 'dequeued': {
        const task = this.tasks.get(event.order.id)
        if (task) {
          const updated = { ...task, status: 'running' as const, startedAt: Date.now() }
          this.tasks.set(task.id, updated)
          this.emit({ type: 'task:started', taskId: task.id })
        }
        break
      }
      case 'completed': {
        const task = this.tasks.get(event.orderId)
        if (task) {
          const updated = { ...task, status: 'completed' as const, completedAt: Date.now() }
          this.tasks.set(task.id, updated)
          this.emit({ type: 'task:completed', taskId: task.id })
        }
        break
      }
      case 'failed': {
        const task = this.tasks.get(event.orderId)
        if (task) {
          const updated = { ...task, status: 'failed' as const, completedAt: Date.now() }
          this.tasks.set(task.id, updated)
          this.emit({ type: 'task:failed', taskId: task.id })
        }
        break
      }
    }
  }

  // ── 查询接口（TUI 消费）──
  getTask(id: string): BoardTask | undefined { return this.tasks.get(id) }
  getTasksByDomain(domain: DomainArea): BoardTask[] { return [...this.tasks.values()].filter(t => t.domain === domain) }
  getAllTasks(): BoardTask[] { return [...this.tasks.values()].sort((a, b) => a.seq - b.seq) }
  getActiveTasks(): BoardTask[] { return [...this.tasks.values()].filter(t => t.status === 'running') }
  getProgress(): { total: number; completed: number; failed: number; running: number } {
    const tasks = [...this.tasks.values()]
    return {
      total: tasks.length,
      completed: tasks.filter(t => t.status === 'completed').length,
      failed: tasks.filter(t => t.status === 'failed').length,
      running: tasks.filter(t => t.status === 'running').length,
    }
  }

  // ── 事件转发（TUI 订阅）──
  on(listener: (event: BoardEvent) => void): () => void {
    this.listeners.push(listener)
    return () => { this.listeners = this.listeners.filter(l => l !== listener) }
  }
  private emit(event: BoardEvent): void {
    for (const l of this.listeners) l(event)
  }
}
```

#### Step 6.2: 测试

- [ ] **创建** `src/agent/__tests__/task-board.test.ts`

测试用例：
1. 监听 queue enqueued 事件 → task:added
2. 监听 queue dequeued 事件 → task:started
3. 监听 queue completed 事件 → task:completed
4. `getTasksByDomain` 按域过滤
5. `getProgress` 正确计数
6. `on()` 返回 unsubscribe

**运行：** `./node_modules/.bin/tsx --test src/agent/__tests__/task-board.test.ts`
**预期：** 6 tests, 0 failures.
**提交：** `feat(agent): add TaskBoard read projection — TUI task view from queue events`

---

## Verification

```bash
# Typecheck
npx tsc --noEmit
# 预期：0 errors

# 修改的测试
./node_modules/.bin/tsx --test \
  src/agent/__tests__/work-order.test.ts \
  src/agent/__tests__/work-queue.test.ts
# 预期：所有测试通过

# 新增测试
./node_modules/.bin/tsx --test \
  src/agent/__tests__/dispatcher.test.ts \
  src/agent/__tests__/dispatcher-hook.test.ts \
  src/agent/__tests__/task-board.test.ts
# 预期：~23 tests, 0 failures

# 全量回归
./node_modules/.bin/tsx --test src/**/__tests__/*.test.ts
# 预期：无新增失败
```

---

## Self-Check

| 需求 | 覆盖 |
|------|------|
| WorkOrder domain 标签 | Task 1 |
| StarDomain toolWhitelist + suffix | Task 2 |
| 队列事件 + 文件冲突检测 | Task 3 |
| 数据流依赖分解 | Task 4 |
| Dispatcher Hook → coordinator | Task 5 |
| TaskBoard 读投影 | Task 6 |
| v1 缺陷：串行依赖 | ✅ 修正为数据流依赖 |
| v1 缺陷：classifyFile 遗漏 | ✅ 新增 prompt/config 域 |
| v1 缺陷：绕过模型路由 | ✅ 通过 coordinator.delegate() |

---

## Execution Handoff

计划已保存到 `docs/superpowers/plans/2026-05-20-three-authority-coroutine-implementation.md`。

两种执行方式：
1. **子代理驱动（推荐）** — 每个 Task 调度一个子代理，Task 间审查。
2. **内联执行** — 当前会话批量执行，设检查点。

选哪种方式？
