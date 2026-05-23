# Agent 协作过程推演：具体场景

> 日期：2026-05-23（修订：2026-05-24）
> 场景：用户要求"修复前端通知组件的显示 bug，同时优化后端 API 的错误处理"
> 涉及域：frontend（TUI 组件）+ backend（API 层）

---

## 场景概览

**用户输入**：
> "通知组件有时候会显示 undefined，帮我修复。同时后端 API 的错误处理太粗糙了，需要优化。"

**涉及文件**：
- frontend: `src/tui/components/notification.tsx`
- backend: `src/api/openai-client.ts`, `src/api/error-handler.ts`

**协作方式**：两个 worker 并行执行，通过信息素协调

---

## 工程映射：概念 → 现有模块

| 设计概念 | 现有模块 | 文件 | 状态 |
|---------|---------|------|------|
| 主 Session / Dispatcher | `DelegationCoordinator` | `src/agent/coordinator.ts` | ✅ 已实现 |
| 乐章级任务分解 | `decomposeByDataContract()` | `src/agent/dispatcher.ts` | ✅ 已实现 |
| Worker A/B 并行执行 | `runWorkerSession` / `runHandsSession` | `src/agent/worker-session.ts`, `hands-session.ts` | ✅ 已实现 |
| 信息素协调 | `StigmergyStore` | `src/context/stigmergy.ts` | ✅ 已实现 |
| 漂移检测 | `CognitiveSeason` + `cerebellar gate` | `src/agent/cognitive-season.ts`, `tool-pipeline.ts` | ✅ 已实现 |
| 锚位拓扑 (HEARTH) | `AnchorGraph` | `src/prompt/anchor-graph.ts` | ❌ 待实现 |
| 义务引擎 (Songline) | — | — | ❌ 待实现 |
| 守火人 | cerebellar gate + scope 检查 | `src/agent/tool-pipeline.ts` L254-262 | ⚠️ 部分覆盖 |
| 阶段转换 | `StarPhase` + `ThetaState` | `src/agent/star-event.ts` | ✅ 已实现 |
| 冲突检测 | `ConflictGradient` + `SemanticLockManager` | `src/agent/conflict-gradient.ts`, `semantic-lock.ts` | ✅ 已实现 |
| 结果合并 | `MergeProtocol` + `aggregateResults` | `src/agent/merge-protocol.ts`, `aggregation.ts` | ✅ 已实现 |

---

## 过程推演（映射到现有代码路径）

### 阶段 0：主 Session 接收任务

```
用户："通知组件有时候会显示 undefined，帮我修复。同时后端 API 的错误处理太粗糙了，需要优化。"
```

**代码路径**：
1. `AgentLoop.run()` → `TurnIntentController` 识别多域任务
2. `extractTaskContract()` 提取 `TaskContract`（`src/context/task-contract.ts`）
3. `dispatcher-hook.ts` 触发 → 调用 `decomposeByDataContract(contract)`

---

### 阶段 1：任务分解

**现有实现**：`decomposeByDataContract()` in `src/agent/dispatcher.ts`

```typescript
// 输入：TaskContract { objective, scope: { mentionedFiles: [...] } }
// 输出：DecomposedTask[]

T0: { title: "修复通知组件 undefined", domain: "frontend", dependsOn: [] }
T1: { title: "优化 API 错误处理", domain: "backend", dependsOn: [] }
// T0 和 T1 无数据流依赖 → 并行
```

**与 HEARTH 的结合点（待实现）**：
- 分解时注入 `pole_void`（禁止事项）作为 `WorkOrder.constraints`
- 分解时注入 `center_belief` 作为 `WorkOrder.objective` 的上下文前缀

**与 Songline 的结合点（待实现）**：
- 每个 `DecomposedTask` 对应一个"乐章"
- 乐章的结束条件不是预设轮次，而是 `CognitiveSeason` 从 `genesis` 转入 `wuwei`
- 义务 = `DecomposedTask.objective`（语义级），不是工具列表

---

### 阶段 2：WorkOrder 创建与调度

**现有实现**：`DelegationCoordinator.delegateBatch()` in `src/agent/coordinator.ts`

```typescript
// 为每个 DecomposedTask 创建 WorkOrder
const orders: WorkOrder[] = [
  createWriteWorkOrder({
    parentTurnId: currentTurn,
    kind: 'patch_proposal',
    profile: 'patcher',
    objective: "修复 notification.tsx 中 undefined 显示问题",
    scope: { files: ['src/tui/components/notification.tsx'] },
    domain: 'frontend',
  }),
  createWriteWorkOrder({
    parentTurnId: currentTurn,
    kind: 'patch_proposal',
    profile: 'patcher',
    objective: "优化 openai-client.ts 和 error-handler.ts 的错误处理",
    scope: { files: ['src/api/openai-client.ts', 'src/api/error-handler.ts'] },
    domain: 'backend',
  }),
]
```

**调度**：`WorkOrderQueue` 检查文件冲突（无冲突）→ 两个 order 同时出队

---

### 阶段 3：并行执行

**现有实现**：

- Write worker → `runHandsSession()` in `src/agent/hands-session.ts`
- 每个 worker 在独立 git worktree 中执行（`WorktreeCoordinator`）
- 每个 worker 有独立的 `AgentLoop` 实例

```
                    DelegationCoordinator.delegateBatch()
                              │
                ┌─────────────┴─────────────┐
                ▼                           ▼
    ┌───────────────────┐        ┌───────────────────┐
    │  Worker A          │        │  Worker B          │
    │  profile: patcher  │        │  profile: patcher  │
    │  domain: frontend  │        │  domain: backend   │
    │  worktree: .wt/a   │        │  worktree: .wt/b   │
    └───────────────────┘        └───────────────────┘
```

**安全机制（已实现）**：
- `SemanticLockManager`：Worker A 锁定 `notification.tsx`，Worker B 锁定 `openai-client.ts`
- `ConflictGradient`：实时检测文件冲突级别（green/yellow/orange/red）
- `DeadlockDetector`：DFS 检测等待图中的环

---

### 阶段 4：信息素协调（实时双向）

**现有实现**：`StigmergyStore` in `src/context/stigmergy.ts`

**关键修正**：信息素不是"完成后单向通知"，而是**过程中持续沉积**。

```
时间线：
T=0  Worker A 启动 → deposit({ path: 'src/tui/components/notification.tsx',
                               signal: 'entry-point', strength: 0.8,
                               context: 'investigating undefined display' })
T=0  Worker B 启动 → deposit({ path: 'src/api/openai-client.ts',
                               signal: 'refactor-candidate', strength: 0.8,
                               context: 'restructuring error handling' })
T=1  Worker B sense('src/tui/') → 发现 Worker A 正在处理前端
     → 不会尝试修改 notification.tsx（即使发现后端返回 undefined）
T=3  Worker A 完成修复 → deposit({ path: 'src/tui/components/notification.tsx',
                                   signal: 'well-tested', strength: 1.0,
                                   context: 'fixed: handles undefined with fallback message' })
T=4  Worker B sense → 知道前端已处理 undefined → 专注于错误分类
```

**与 Songline 的结合点（待实现）**：
- 信息素沉积 = Songline 的"歌声残留"
- 每次 `deposit()` 是一次"唱歌"——在路径上留下痕迹
- 信号类型扩展：增加 `scope-claim`（声明正在处理的范围）

---

### 阶段 5：漂移检测与校准

**现有实现**：

1. **cerebellar gate**（`src/agent/tool-pipeline.ts` L254-262）：
   - 检测 prediction error rate 升高 → 阻止 edit_file 直到 read_file
   - 已实现"读后写"强制

2. **CognitiveSeason**（`src/agent/cognitive-season.ts`）：
   - `reversal` 季节 = 漂移检测（doom loop level 升高）
   - `genesis` → `reversal` 转换 = "检测到问题"

3. **PredictionAccumulator**（`src/agent/prediction-error.ts`）：
   - 累积预测误差 → 触发 intervention level 升级

**推演**：

```
Worker A Turn 3: 尝试修改 src/api/error-handler.ts（不在 scope 内）
  → SemanticLockManager: Worker B 已锁定该文件 → 拒绝
  → ConflictGradient: 'orange' → 记录冲突
  → Worker A 收到 tool_result.is_error = true
  → PredictionAccumulator 累积误差
  → 如果连续 2 次 → intervention level 升级为 'gate'
  → cerebellar gate 阻止后续 edit 直到 read_file 重新校准
```

**与 HEARTH 的结合点（待实现）**：
- INV-1（乾坤互补）→ Worker 的 scope（structure）和 constraints（void）互补
- INV-3（中孚环绕）→ `center_belief` 在每次 gate 触发时注入提醒
- INV-5（漂移检测）→ 扩展现有 `detect_drift` 到 scope 边界检查

**守火人 = 现有机制的组合**：
- cerebellar gate（已有）+ scope 边界检查（SemanticLock 已有）+ 信念提醒（待实现）
- 不需要新角色，只需要在 gate 触发时注入 `center_belief` 上下文

---

### 阶段 6：阶段转换（替代预设轮次）

**现有实现**：`StarPhase` + `CognitiveSeason`

**关键设计**：不预设轮次，由 agent 行为驱动阶段转换。

```typescript
// 现有 StarPhase 映射（src/agent/loop.ts L85-95）
const PHASE_CLASS_MAP = {
  'tianshu-planning': 'plan',
  'tianxuan-locating': 'explore',
  'yuheng-implementing': 'execute',
  'kaiyang-testing': 'verify',
  'yaoguang-delivering': 'deliver',
}
```

**Worker 的阶段转换是自然的**：
- Worker 开始 → `genesis` 季节 → 读文件、理解问题
- Worker 开始写代码 → `StarPhase` 转入 `yuheng-implementing`
- Worker 跑测试 → `StarPhase` 转入 `kaiyang-testing`
- 测试通过 → `wuwei` 季节 → 自然结束

**与 Songline 的结合点（待实现）**：
- "乐章"的结束 = `CognitiveSeason` 从 `genesis` 完整走到 `wuwei`
- 一个 Worker 可能经历多个"乐章"（多次 genesis→wuwei 循环）
- 每次 `wuwei` 到达时沉积 `cycle_close` 信息素

---

### 阶段 7：验证与交付

**现有实现**：

1. Worker 完成 → 返回 `WorkerResult`（`src/agent/work-order.ts`）
2. `worker-evidence.ts` 验证 evidence 完整性
3. `aggregateResults()` 合并多个 worker 结果
4. `MergeProtocol` 处理 git worktree 合并

```typescript
// WorkerResult 已有的结构
interface WorkerResult {
  workOrderId: string
  status: 'passed' | 'failed' | 'partial' | 'timeout'
  summary: string
  findings: Finding[]
  changedFiles: string[]
  risks: string[]
  nextActions: string[]
  evidenceStatus: 'verified' | 'unverified' | 'failed'
  verification?: VerificationMetadata
}
```

**合并流程**：
1. `MergeQueue` 按 conflict level 排序
2. Worker A 结果（frontend）→ `auto_cherry_pick`（无冲突）
3. Worker B 结果（backend）→ `auto_cherry_pick`（无冲突）
4. 主 Session 运行完整测试套件验证

---

## 待实现：HEARTH + Songline 增强层

### 增强 1：锚位投影注入 Worker

**位置**：`src/agent/worker-prompts.ts` → `buildPrimaryWorkerPacket()`

**改动**：在 worker prompt 中注入简化的锚位投影

```typescript
// 待实现：在 buildPrimaryWorkerPacket 中追加
interface AnchorProjection {
  structure: string[]    // 从 .rivet/rules/ 提取的编码规范
  void: string[]         // 从 WorkOrder.constraints 提取的禁止事项
  belief: string         // center_belief（一句话）
  cycleContext: string   // 当前任务的上下文
}
```

**注意**：不用 XML 格式，用扁平文本。先 A/B 测试再决定格式。

### 增强 2：义务引擎

**位置**：新建 `src/agent/obligation.ts`

**设计**：义务是语义级的，不是工具级的。

```typescript
interface Obligation {
  id: string
  description: string           // "理解 notification.tsx 的 undefined 来源"
  completionSignal: string      // "找到 undefined 的根因并记录在 findings 中"
  allowedTools?: string[]       // 可选的工具约束
  maxTurns?: number             // 可选的轮次上限（软限制）
}

interface ObligationEngine {
  current(): Obligation | null
  advance(evidence: Finding[]): void  // 根据 evidence 判断是否完成
  isComplete(): boolean
}
```

**与现有模块的关系**：
- `Obligation.completionSignal` 对应 `TaskLedger` 的事件模式
- `ObligationEngine.advance()` 由 `TurnCompletionController` 在每轮结束时调用
- 义务完成 = `CognitiveSeason` 进入 `wuwei`

### 增强 3：实时 Scope 声明信息素

**位置**：扩展 `StigmergyStore` 的信号类型

```typescript
// 在 src/agent/sensorium.ts 的 PheromoneSignal 中增加
type PheromoneSignal = 
  | 'fragile' | 'well-tested' | 'entry-point' | 'dead-end'
  | 'coupling-hub' | 'performance-critical' | 'refactor-candidate'
  | 'scope-claim'      // 新增：声明正在处理的范围
  | 'scope-complete'   // 新增：声明已完成处理
```

**Worker 启动时**：
```typescript
// 在 runHandsSession / runWorkerSession 启动时
for (const file of order.scope.files ?? []) {
  await stigmergy.deposit({ path: file, signal: 'scope-claim', strength: 1.0,
    context: `worker=${order.id} objective=${order.objective}` })
}
```

**Worker 完成时**：
```typescript
// 在 worker 返回 WorkerResult 后
for (const file of result.changedFiles) {
  await stigmergy.deposit({ path: file, signal: 'scope-complete', strength: 1.0,
    context: result.summary })
}
```

### 增强 4：守火人 = Gate + Scope + Belief

**位置**：扩展 `src/agent/tool-pipeline.ts` 的 cerebellar gate

```typescript
// 现有 gate（L254-262）检查 "read before edit"
// 扩展：检查 "scope boundary"
if (tu.name === 'edit_file' || tu.name === 'write_file') {
  const targetFile = tu.input.file_path as string
  const inScope = deps.workOrderScope?.files?.some(f => targetFile.includes(f))
  if (!inScope) {
    // 检查信息素：是否有其他 worker 声明了 scope-claim
    const pheromones = await deps.stigmergy?.query(targetFile)
    const otherClaim = pheromones?.find(p => p.signal === 'scope-claim')
    if (otherClaim) {
      return gateBlock(`File ${targetFile} is claimed by another worker: ${otherClaim.context}`)
    }
  }
}
```

---

## 分布式 INV 问题（HEARTH 在多 Worker 场景）

### 设计决策：AnchorGraph 是 per-worker 的

每个 Worker 维护自己的 AnchorGraph 实例，但共享 `pole_structure` 和 `center_belief`（这两个是 project 级不变的）。

| 锚位 | 共享方式 |
|------|---------|
| `pole_structure` | 共享（project 级，所有 worker 相同） |
| `pole_void` | per-worker（每个 worker 的 constraints 不同） |
| `cycle_close` | per-worker（每个 worker 独立完成） |
| `cycle_open` | per-worker（每个 worker 独立启动） |
| `center_belief` | 共享（project 级） |

### INV 在多 Worker 场景的适配

| INV | 单 Session 语义 | 多 Worker 语义 |
|-----|----------------|---------------|
| INV-1 | structure XOR void = FULL | Worker 的 scope + constraints 互补 |
| INV-2 | cycle 首尾相接 | Worker 的 `cycle_open` 引用主 Session 的 dispatch 时间戳 |
| INV-3 | belief 被环绕 | 每个 Worker 的 prompt 包含 `center_belief` |
| INV-4 | cycle_open 每 session 变化 | 每个 Worker 的 `cycle_open` 天然不同 |
| INV-5 | 漂移检测 | 每个 Worker 独立检测 + 主 Session 检测 aggregate 结果 |

---

## 实施优先级

| 优先级 | 改动 | 文件 | 依赖 |
|--------|------|------|------|
| P0 | scope-claim 信息素 | `sensorium.ts` + `hands-session.ts` | 无 |
| P0 | scope 边界 gate | `tool-pipeline.ts` | scope-claim |
| P1 | 锚位投影注入 worker prompt | `worker-prompts.ts` | HEARTH Phase 1 |
| P1 | 义务引擎 | 新建 `obligation.ts` | 无 |
| P2 | CognitiveSeason 驱动乐章结束 | `turn-completion.ts` | 义务引擎 |
| P2 | 分布式 INV 校验 | `anchor-graph.ts` | HEARTH Phase 1 |
| P3 | A/B 测试锚位格式 | telemetry | P1 完成后 |

---

## 与现状对比（修订）

| 维度 | 现状（已实现） | 增强后（待实现） |
|------|--------------|----------------|
| 上下文注入 | `buildPrimaryWorkerPacket` + active claims | + 锚位投影（structure/void/belief） |
| 任务分解 | `decomposeByDataContract`（文件→域） | + 义务引擎（语义级目标） |
| 错误检测 | cerebellar gate + PredictionAccumulator | + scope 边界检查 + 信息素感知 |
| 跨域协调 | `SemanticLockManager` + `ConflictGradient` | + scope-claim 信息素（实时双向） |
| 阶段转换 | `StarPhase` + `CognitiveSeason` | + 义务完成驱动（替代预设轮次） |
| 协调方式 | `DelegationCoordinator`（中央调度） | + 信息素自组织（分布式校准） |

---

## 总结

这个推演展示了 HEARTH + Songline 如何**增量叠加**在已有的协作基础设施上：

1. **不替换** `DelegationCoordinator` / `WorkOrderQueue` / `MergeProtocol` — 它们是可靠的骨架
2. **增强** worker prompt（锚位投影）、gate 逻辑（scope 边界）、信息素（scope-claim）
3. **替代** 预设轮次 → 用 `CognitiveSeason` 自然转换
4. **新增** 义务引擎作为语义级目标追踪

核心原则：**现有代码是骨架，HEARTH 是参考系，Songline 是协调层。三者正交叠加，不互相替换。**
