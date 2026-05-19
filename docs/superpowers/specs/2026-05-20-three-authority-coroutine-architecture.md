# 三权协程调度 — 多 Agent 协作架构设计

> 日期：2026-05-20
> 前置：StarDomain (破军/天府/天梁) + DelegationCoordinator + TaskContract + StigmergyStore
> 执行模型：进程内协程（三权域 = 同进程内独立 AgentLoop 实例，共享 TaskBoard）

---

## 核心洞察

当前架构已经有两个关键基础设施：

1. **DelegationCoordinator** — 已实现 work order 分发、worker session、hands session、worktree 隔离
2. **StarDomain** — 已实现三权域匹配（破军 bold / 天府 cautious / 天梁 methodical）

缺失的是**连接层**：TaskContract 分解后的子任务如何映射到三权域，如何并发执行，如何在 TUI 中可视化。

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

### 数据结构

```typescript
// src/agent/task-board.ts

export type TaskStatus =
  | 'pending'      // 等待依赖完成
  | 'ready'        // 依赖满足，等待分配
  | 'assigned'     // 已分配给某权域
  | 'running'      // 执行中
  | 'blocked'      // 执行受阻
  | 'completed'    // 完成
  | 'failed'       // 失败

export type AuthorityDomain = 'pojun' | 'tianfu' | 'tianliang' | 'primary'

export interface BoardTask {
  id: string
  seq: number              // 自增序号 T1, T2, T3...
  title: string            // 简短描述
  objective: string        // 详细目标
  domain: AuthorityDomain  // 分配的权域
  status: TaskStatus
  dependsOn: string[]      // 依赖的 task id
  scope: {
    files: string[]        // 涉及的文件
    symbols?: string[]     // 涉及的符号
  }
  constraints: string[]    // 从 TaskContract 继承
  result?: WorkerResult    // 执行结果
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

### 分解策略

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

      // 1. 检查是否需要分解（复杂度阈值）
      const sensorium = deps.getSensorium()
      if (sensorium && sensorium.complexity < 0.3) return  // 简单任务不分解

      // 2. 分解为子任务
      const subtasks = decomposeContract(contract)

      // 3. 为每个子任务匹配权域
      for (const subtask of subtasks) {
        subtask.domain = matchDomain(subtask.objective) ?? 'tianliang'
      }

      // 4. 注册到 TaskBoard
      deps.board.addTasks(subtasks)

      // 5. 调度就绪任务
      dispatchReadyTasks(deps.board, deps.coordinator)
    },
  }
}
```

### 权域匹配（复用现有 StarDomain）

```typescript
function decomposeContract(contract: TaskContract): SubtaskInput[] {
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

## 三、Worker AgentLoop — 三权域实例

### 进程内协程模型

每个 Worker 是一个独立的 `AgentLoop` 实例，但共享：

| 共享 | 隔离 |
|------|------|
| TaskBoard (只读查询 + 写入自己任务状态) | SessionContext (独立消息历史) |
| StigmergyStore (读写 pheromone) | PromptEngine (独立 volatile context) |
| ToolRegistry (工具定义共享) | EvidenceTracker (独立证据) |
| ProcessTracker (进程管理) | TaskContract (独立合约) |

### 权域特化

```typescript
const DOMAIN_CONFIGS: Record<AuthorityDomain, WorkerDomainConfig> = {
  pojun: {
    name: '破军',
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

## 四、TUI 任务面板 — Observatory 集成

### 星图 + 任务面板联动

```
╭── 紫微天文台 ──────────────────────────────────────────────╮
│                                                            │
│  ⭐ ──── 🔍 ──── 📐 ──── 📜                               │
│  天枢    天璇    天玑    天权                               │
│                                  │                         │
│                                 🔨 ← 当前                   │
│                                 玉衡                        │
│                                  │                         │
│                             ⚔️ ──── 🏠                     │
│                             开阳    摇光                    │
│                                                            │
│  ── 任务面板 ──────────────────────────────────────────────│
│                                                            │
│  T1 ⚔️ 分析 auth 模块结构      [天梁] ✅ 0:45              │
│  T2 🔨 重构 middleware 依赖     [破军] 🔄 1:23 ← 当前       │
│  T3 📜 提取 shared types        [天府] ⏳ 等待 T2           │
│  T4 ⭐ 编写集成测试             [天梁] ⏳ 等待 T2+T3        │
│                                                            │
│  进度 ██▓░░░░░ 2/4 │ 破军×1 天府×0 天梁×0 空闲×2          │
│                                                            │
│  ── sensorium ─────────────────────────────────────────────│
│  momentum ⣿⣿⣿⣿⣿⣿⣷⣄  confidence ⣿⣿⣿⣷⣄⣀⣀⣀             │
│  pressure ⣿⣷⣄⣀⣀⣀⣀⣀  complexity ⣿⣿⣀⣀⣀⣀⣀⣀             │
│                                                            │
╰────────────────────────────────────────────────────────────╯
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
| `coupling-hub` | import 分析 | 所有域 | 该文件耦合度高，修改需谨慎 |

新增信号：

| 信号 | 含义 |
|------|------|
| `task:blocked:{taskId}` | 某任务受阻，其他域可协助 |
| `file:claimed:{path}` | 某域正在修改该文件，其他域避免冲突 |
| `insight:{domain}:{summary}` | 某域发现的关键信息，其他域可复用 |

---

## 六、实施路径

### Phase 0: TaskBoard 基础（纯数据结构 + 测试）
- `src/agent/task-board.ts` — TaskBoard class + BoardTask types
- `src/agent/__tests__/task-board.test.ts` — 任务生命周期测试
- 零外部依赖，纯函数 + 事件

### Phase 1: Dispatcher Hook（任务分解 + 分配）
- `src/agent/hooks/dispatcher-hook.ts` — 从 TaskContract 分解子任务
- 复用 `matchDomain()` 做权域匹配
- 注册到 RuntimeHookPipeline

### Phase 2: Worker AgentLoop（三权域执行）
- `src/agent/worker-loop.ts` — 轻量级 AgentLoop 变体
- 权域特化配置（工具白名单、system prompt suffix）
- 共享 StigmergyStore，隔离 SessionContext

### Phase 3: TUI 任务面板
- `src/tui/task-panel.tsx` — 任务列表 + 状态 + 进度条
- 集成到 Observatory 布局
- TaskBoard 事件 → TUI 实时更新

### Phase 4: 高级协调
- Pheromone 扩展信号（task:blocked, file:claimed, insight）
- 任务重试 + 降级策略
- 跨域知识共享（一个域的发现自动注入其他域的 context）
