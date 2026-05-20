# 三权协程调度 — 多 Agent 协作架构设计

> 日期：2026-05-20
> 前置：StarDomain (破军/天府/天梁) + DelegationCoordinator + TaskContract + StigmergyStore
> 执行模型：进程内协程（三权域 = 同进程内独立 AgentLoop 实例，共享 TaskBoard）
> 设计原则：先做后端中间层，TUI 适配后置

---

## 核心洞察

### 分解维度：双轴

```
         行为轴（怎么干）           领域轴（干什么）
         ─────────────            ─────────────
         破军 — 探索突破           frontend — TUI/组件/渲染
         天府 — 谨慎守护           backend  — agent/api/tools
         天梁 — 精确交付           config   — schema/设置/CLI
                                  docs     — 设计文档/规格
```

**领域轴是团队协同的天然边界。** 同一个文件不会被两个域同时修改。
行为轴是决策风格，叠加在领域轴之上。

### 多轮执行

Worker = 独立 AgentLoop 实例，支持完整多轮：
- 读文件 → 写代码 → 跑测试 → 失败 → 修复 → 再测试 → 通过
- 每轮有独立的 SessionContext、EvidenceTracker、TaskContract
- 预算控制：maxTurns / maxTokens / timeoutMs

### 与现有 DelegationCoordinator 的关系

```
现有：DelegationCoordinator → WorkerSession（单次 work order，read-only 或 write）
演化：TaskBoard → Dispatcher → 多个 WorkerLoop（多轮，领域隔离，并发）

不是替换，是在 Coordinator 之上加一层任务编排。
```

---

## 架构总览

```
用户输入
  │
  ▼
┌─────────────────────────────────────────────────────────┐
│                    天枢 · 主 AgentLoop                    │
│  ┌─────────────┐  ┌──────────────┐  ┌─────────────────┐ │
│  │ TaskContract │→│ TaskBoard    │→│ Dispatcher Hook │ │
│  │ extract()   │  │ decompose()  │  │ assign+launch() │ │
│  └─────────────┘  └──────────────┘  └────────┬────────┘ │
│                                              │          │
│         ┌────────────────────────────────────┼──────┐   │
│         ▼                    ▼               ▼      │   │
│  ┌─────────────┐  ┌──────────────┐  ┌────────────┐ │   │
│  │  破军 Worker │  │  天府 Worker  │  │ 天梁 Worker │ │   │
│  │  bold/explore│  │ cautious/guard│  │ methodical │ │   │
│  │  AgentLoop   │  │  AgentLoop   │  │  AgentLoop │ │   │
│  └──────┬──────┘  └──────┬───────┘  └─────┬──────┘ │   │
│         │                │                 │        │   │
│         └────────────────┼─────────────────┘        │   │
│                          ▼                           │   │
│                   ┌─────────────┐                    │   │
│                   │  TaskBoard  │ ← 共享状态          │   │
│                   │  (in-memory)│                    │   │
│                   └──────┬──────┘                    │   │
│                          │                           │   │
│                   ┌──────▼──────┐                    │   │
│                   │ Stigmergy   │ ← 跨域协调信号       │   │
│                   │ Store       │                    │   │
│                   └─────────────┘                    │   │
└─────────────────────────────────────────────────────────┘
                          │
                          ▼
                   ┌─────────────┐
                   │  TUI Panel  │ ← 星图 + 任务面板
                   │  Observatory│
                   └─────────────┘
```

---

## 一、TaskBoard — 共享任务注册表

### 双轴标签

```typescript
// src/agent/task-board.ts

/** 领域轴 — 代码区域，团队协同的天然边界 */
export type DomainArea = 'frontend' | 'backend' | 'config' | 'docs' | 'tools' | 'tests'

/** 行为轴 — 决策风格，叠加在领域之上 */
export type AuthorityDomain = 'pojun' | 'tianfu' | 'tianliang' | 'primary'

export type TaskStatus =
  | 'pending'      // 等待依赖完成
  | 'ready'        // 依赖满足，等待分配
  | 'assigned'     // 已分配给某 worker
  | 'running'      // 执行中（多轮）
  | 'blocked'      // 执行受阻
  | 'completed'    // 完成
  | 'failed'       // 失败

export interface BoardTask {
  id: string
  seq: number              // 自增序号 T1, T2, T3...
  title: string            // 简短描述
  objective: string        // 详细目标
  domain: DomainArea       // 领域轴：哪个代码区域
  authority: AuthorityDomain // 行为轴：哪种决策风格
  status: TaskStatus
  dependsOn: string[]      // 依赖的 task id
  scope: {
    files: string[]        // 涉及的文件（领域隔离依据）
    symbols?: string[]     // 涉及的符号
  }
  constraints: string[]    // 从 TaskContract 继承
  budget: {
    maxTurns: number       // 多轮上限
    maxTokens: number
    timeoutMs: number
  }
  result?: WorkerResult    // 执行结果
  turns: number            // 已执行轮数
  createdAt: number
  startedAt?: number
  completedAt?: number
  retryCount: number
}

export interface TaskBoardState {
  tasks: BoardTask[]
  activeTaskId: string | null
  createdAt: number
}
```

### 核心操作（纯函数 + 事件驱动）

```typescript
export class TaskBoard {
  private tasks: Map<string, BoardTask> = new Map()
  private seq = 0
  private listeners: Array<(event: BoardEvent) => void> = []

  // ── 分解 ──
  addTask(partial: Omit<BoardTask, 'id' | 'seq' | 'status' | 'createdAt' | 'retryCount'>): BoardTask
  addTasks(tasks: Array<Omit<BoardTask, 'id' | 'seq' | 'status' | 'createdAt' | 'retryCount'>>): BoardTask[]

  // ── 调度 ──
  getReadyTasks(): BoardTask[]           // status=ready && dependsOn 全部 completed
  assignTask(taskId: string, domain: AuthorityDomain): void
  startTask(taskId: string): void

  // ── 生命周期 ──
  completeTask(taskId: string, result: WorkerResult): void
  failTask(taskId: string, error: string): void
  blockTask(taskId: string, reason: string): void

  // ── 查询 ──
  getTask(id: string): BoardTask | undefined
  getTasksByDomain(domain: AuthorityDomain): BoardTask[]
  getActiveTasks(): BoardTask[]
  getProgress(): { total: number; completed: number; failed: number; running: number }

  // ── 事件 ──
  on(listener: (event: BoardEvent) => void): void
}

export type BoardEvent =
  | { type: 'task:added'; task: BoardTask }
  | { type: 'task:assigned'; taskId: string; domain: AuthorityDomain }
  | { type: 'task:started'; taskId: string }
  | { type: 'task:completed'; taskId: string; result: WorkerResult }
  | { type: 'task:failed'; taskId: string; error: string }
  | { type: 'task:blocked'; taskId: string; reason: string }
```

---

## 二、Dispatcher Hook — 任务分解 + 分配

### 触发时机

在 `RuntimeHookPipeline` 中新增 `afterPerception` 阶段的 dispatcher hook：

```
preTurn → [existing hooks] → afterPerception → [dispatcher] → LLM call → postTool → postTurn
```

### 分解策略：领域优先 + 行为叠加

```typescript
// src/agent/hooks/dispatcher-hook.ts

export function createDispatcherHook(deps: {
  board: TaskBoard
  coordinator: DelegationCoordinator
  getTaskContract: () => TaskContract | undefined
  getSensorium: () => Sensorium | null
}): AfterPerceptionRuntimeHook {
  return {
    phase: 'afterPerception',
    name: 'task-dispatcher',
    run(ctx) {
      const contract = deps.getTaskContract()
      if (!contract || !contract.isActionable) return

      // 1. 简单任务不分解（复杂度阈值）
      const sensorium = deps.getSensorium()
      if (sensorium && sensorium.complexity < 0.3) return

      // 2. 按领域轴分解（文件路径 → DomainArea）
      const subtasks = decomposeByDomain(contract)

      // 3. 叠加行为轴（matchDomain 基于关键词 → 破军/天府/天梁）
      for (const subtask of subtasks) {
        subtask.authority = matchDomain(subtask.objective) ?? 'tianliang'
      }

      // 4. 注册到 TaskBoard（自动分配 seq: T1, T2, T3...）
      deps.board.addTasks(subtasks)

      // 5. 调度就绪任务到 WorkerLoop
      dispatchReadyTasks(deps.board, deps.coordinator)
    },
  }
}
```

### 领域分解示例

用户说 "重构 auth 模块并添加测试"：
文件涉及 src/agent/auth.ts, src/tui/login.tsx, src/agent/__tests__/auth.test.ts

```
T1 [backend]  分析 auth 模块结构       天府(谨慎)  → 无依赖
T2 [backend]  重构 middleware 依赖      破军(突破)  → 依赖 T1
T3 [frontend] 更新 login 组件           天梁(精确)  → 依赖 T2
T4 [tests]    编写集成测试              天梁(方法)  → 依赖 T2+T3
```

**领域隔离 = 文件不冲突。** T1/T2 改 backend 文件，T3 改 frontend 文件，天然并行。

```typescript
function classifyFile(path: string): DomainArea {
  if (/src\/tui\//.test(path)) return 'frontend'
  if (/src\/(agent|api|compact|context)\//.test(path)) return 'backend'
  if (/src\/(config|tools)\//.test(path)) return 'tools'
  if (/docs\//.test(path)) return 'docs'
  if (/\.(test|spec)\./.test(path)) return 'tests'
  return 'backend'
}
  // 基于 constraints + scope 生成子任务
  // 例：用户说 "重构 auth 模块并添加测试"
  // → T1: 分析 auth 模块结构 (tianfu - 谨慎分析)
  // → T2: 重构核心逻辑 (pojun - 破旧立新)
  // → T3: 编写测试 (tianliang - 精确验证)
  // → T4: 集成验证 (tianliang - 方法论验证)
  // T2 依赖 T1, T3 依赖 T2, T4 依赖 T2+T3
}
```

---

## 三、WorkerLoop — 多轮执行引擎

### 复用现有 AgentLoop

Worker 不是新代码，是 `AgentLoop` 的受限实例：

```typescript
// src/agent/worker-loop.ts

export interface WorkerLoopConfig {
  task: BoardTask
  client: StreamClient
  toolRegistry: ToolRegistry
  cwd: string
  stigmergy: StigmergyStore  // 共享
  board: TaskBoard           // 共享（只写自己的状态）
}

export async function runWorkerLoop(config: WorkerLoopConfig): Promise<WorkerResult> {
  const { task, board } = config

  // 1. 创建独立 SessionContext（不与主 session 共享）
  const session = new SessionContext()

  // 2. 创建独立 PromptEngine（带领域特化的 system prompt suffix）
  const promptEngine = createDomainPromptEngine(task.authority, config)

  // 3. 创建受限 ToolRegistry（按领域过滤）
  const tools = filterToolRegistry(config.toolRegistry, DOMAIN_TOOL_ALLOWLIST[task.authority])

  // 4. 创建 AgentLoop 实例
  const loop = new AgentLoop({
    client: config.client,
    promptEngine,
    toolRegistry: tools,
    session,
    maxTurns: task.budget.maxTurns,  // 多轮！
    // ... 其他配置
  })

  // 5. 执行多轮（读→写→测试→修复→测试...）
  board.startTask(task.id)
  const result = await loop.run(task.objective, {
    onToolResult: (toolResult) => {
      // 实时更新 TaskBoard（TUI 可消费）
      board.reportToolUse(task.id, toolResult)
    },
    onTurnComplete: (turn) => {
      task.turns = turn
      board.reportTurn(task.id, turn)
    },
  })

  // 6. 解析结果，更新 TaskBoard
  board.completeTask(task.id, parseResult(result))
  return parseResult(result)
}
    systemPromptSuffix: '你是破军——探索者。大胆尝试，容忍失败，追求突破。',
    toolAllowlist: ['read_file', 'write_file', 'edit_file', 'bash', 'grep', 'glob', 'diff', 'run_tests'],
    reasoningEffort: 'high',
    approvalMode: 'auto-safe',  // 需要用户确认危险操作
    courageThreshold: 0.3,      // 低阈值 = 更敢冒险
  },
  tianfu: {
    name: '天府',
    systemPromptSuffix: '你是天府——守护者。评估风险，保护资产，谨慎决策。',
    toolAllowlist: ['read_file', 'grep', 'glob', 'diff', 'inspect_project', 'repo_map', 'related_tests'],
    reasoningEffort: 'medium',
    approvalMode: 'auto-accept',  // 只读操作，自动批准
    courageThreshold: 0.5,
  },
  tianliang: {
    name: '天梁',
    systemPromptSuffix: '你是天梁——执行者。严格按计划，精确交付，不妥协质量。',
    toolAllowlist: ['read_file', 'write_file', 'edit_file', 'bash', 'grep', 'glob', 'diff', 'run_tests'],
    reasoningEffort: 'medium',
    approvalMode: 'auto-safe',
    courageThreshold: 0.7,      // 高阈值 = 更谨慎
  },
}
```

---

## 四、领域特化配置

```typescript
const DOMAIN_CONFIGS: Record<AuthorityDomain, WorkerDomainConfig> = {
  pojun: {
    name: '破军',
    systemPromptSuffix: '你是破军——探索者。大胆尝试，容忍失败，追求突破。',
    toolAllowlist: ['read_file', 'write_file', 'edit_file', 'bash', 'grep', 'glob', 'diff', 'run_tests'],
    reasoningEffort: 'high',
    approvalMode: 'auto-safe',
    courageThreshold: 0.3,
  },
  tianfu: {
    name: '天府',
    systemPromptSuffix: '你是天府——守护者。评估风险，保护资产，谨慎决策。',
    toolAllowlist: ['read_file', 'grep', 'glob', 'diff', 'inspect_project', 'repo_map', 'related_tests'],
    reasoningEffort: 'medium',
    approvalMode: 'auto-accept',
    courageThreshold: 0.5,
  },
  tianliang: {
    name: '天梁',
    systemPromptSuffix: '你是天梁——执行者。严格按计划，精确交付，不妥协质量。',
    toolAllowlist: ['read_file', 'write_file', 'edit_file', 'bash', 'grep', 'glob', 'diff', 'run_tests'],
    reasoningEffort: 'medium',
    approvalMode: 'auto-safe',
    courageThreshold: 0.7,
  },
}
```

---

## 五、Pheromone 协调 — 跨域信号

三权域通过 StigmergyStore 协调，无需直接通信：

| 信号 | 生产者 | 消费者 | 含义 |
|------|--------|--------|------|
| `dead-end` | 任意域执行失败 | 所有域 | 避免重复失败路径 |
| `fragile` | 写入后测试失败 | 其他域 | 该文件脆弱，谨慎修改 |
| `well-tested` | 写入后测试通过 | 其他域 | 该文件安全，可大胆改 |
| `entry-point` | 多次读取 | 所有域 | 该文件是入口，优先理解 |
| `file:claimed:{path}` | 某域开始修改 | 其他域 | 避免文件冲突 |
| `insight:{domain}:{summary}` | 某域发现 | 其他域 | 知识共享 |

---

## 六、实施路径（后端中间层优先）

### Phase 0: TaskBoard 核心（纯数据结构 + 事件）
- `src/agent/task-board.ts` — BoardTask types + TaskBoard class + 事件系统
- `src/agent/__tests__/task-board.test.ts` — 任务生命周期 + 依赖解析 + 并发安全
- 零外部依赖，纯函数

### Phase 1: Dispatcher（领域分解 + 权域匹配）
- `src/agent/dispatcher.ts` — decomposeByDomain() + 权域叠加
- `src/agent/hooks/dispatcher-hook.ts` — RuntimeHookPipeline 集成
- `src/agent/__tests__/dispatcher.test.ts` — 分解策略测试

### Phase 2: WorkerLoop（多轮执行引擎）
- `src/agent/worker-loop.ts` — 基于 AgentLoop 的受限实例
- 领域特化配置（工具白名单、system prompt suffix）
- 共享 StigmergyStore，隔离 SessionContext
- `src/agent/__tests__/worker-loop.test.ts` — 多轮执行 + 预算控制

### Phase 3: 调度器（依赖解析 + 并发控制）
- `src/agent/scheduler.ts` — 就绪任务检测 + 并发 worker 管理
- 文件冲突检测（file:claimed pheromone）
- `src/agent/__tests__/scheduler.test.ts`

### Phase 4: TUI 任务面板（后置）
- `src/tui/task-panel.tsx` — 任务列表 + 状态 + 进度条
- 消费 TaskBoard 事件流
- 集成到 Observatory 布局
