# Rivet Architecture Overview

> v2.9.0 · TUI 2.x · Node.js 22+ / TypeScript strict / Ink 6 / node:test / ESM

## 项目定位

Rivet 是一个针对 DeepSeek V4 prefix cache 优化的终端编码 Agent。核心差异化：通过 prompt 分层（static anchor + volatile payload）最大化 prefix cache hit rate，同时通过 9 个运行时 hook 实现自调节（StarFlow/TUI 2.x）。

## 五层架构

```
┌─────────────────────────────────────────────────────────────────────┐
│  Layer 0: TUI (Ink 6 React)                                         │
│  app.tsx → StreamOutput, ToolCard, GlanceBar, InputBar, Cockpit     │
│  RenderBatcher, SteerBuffer, ActivityStatus, SurfaceRouter          │
├─────────────────────────────────────────────────────────────────────┤
│  Layer 1: Agent Loop (src/agent/)                                   │
│  loop.ts → TurnHarness → ToolExecutionController                   │
│           → TurnStreamController → TurnCompletionController         │
│           → CompactionController → ContextInjectionController       │
│  RuntimeHookPipeline (9 hooks, 5 phases)                            │
│  Coordinator + WorkerSession (multi-model delegation)               │
├─────────────────────────────────────────────────────────────────────┤
│  Layer 2: Context & Cognition (src/context/)                        │
│  CognitiveLedger, TaskContract, ClaimStore, Stigmergy               │
│  PressureMonitor, FsWatcher, SessionMemory, ProjectMemory           │
│  AnchorRegistry, Antibody, Dead-end Rules                           │
├─────────────────────────────────────────────────────────────────────┤
│  Layer 3: Prompt Engineering (src/prompt/)                          │
│  PromptEngine: static.ts (anchor) + volatile.ts (dynamic payload)  │
│  AnchorGraph, AnchorInvariants, Fingerprint (cache stability)       │
│  FieldHabituation (anti-prompt-fatigue)                             │
├─────────────────────────────────────────────────────────────────────┤
│  Layer 4: API & Model (src/api/ + src/model/)                       │
│  openai-client.ts, anthropic-client.ts, codex-client.ts             │
│  StreamClient (SSE), RetryEngine, ErrorClassifier                   │
│  ProviderRegistry, ProviderProfile, PrefixCompletion                │
│  ModelCapabilityCard, RoutingMetrics, TaskInferrer                  │
└─────────────────────────────────────────────────────────────────────┘
```

## 核心子系统

### Agent Loop (心脏)

`src/agent/loop.ts` 主循环，每个 turn：

1. **PreTurn** → RuntimeHookPipeline preTurn phase
2. **Perception** → TurnPerceptionController（接收 API 流）
3. **Tool Execution** → ToolExecutionController（执行 tool calls）
4. **Post-Tool** → postTool hooks（stigmergy 更新、evidence 追踪）
5. **Compaction** → CompactionController（上下文压缩决策）
6. **PostTurn** → hook pipeline postTurn phase

关键控制器：

| 控制器 | 职责 |
|--------|------|
| TurnHarness | 单 turn 生命周期管理 |
| CompactionController | 基于 staleRoundThresholds 驱动压缩 |
| RepairPipeline | 修复 malformed tool JSON (DeepSeek V4 bug) |
| CacheAdvisor | prefix cache 命中率监控与建议 |

### RuntimeHookPipeline (自调节)

5 phases: `preTurn → afterPerception → postTool → postTurn → postSession`

9 hooks:

| Hook | 职责 |
|------|------|
| signal-consumer | 消费外部信号 |
| perception | 感知融合 |
| vigor | 活力/能量状态管理 |
| theta | θ 检查（认知漂移检测） |
| kick | 卡死唤醒 |
| stigmergy | 痕迹信息素管理 |
| playbook-reflect | playbook 反思 |
| dream | 会话间学习 |
| telemetry-flush | 遥测写入 |

### Cognitive Layer (认知基座)

| 模块 | 职责 |
|------|------|
| CognitiveLedger | 认知镜面 — 模型看到自己的认知状态 (paravirtualization) |
| TaskContract | 任务契约 — 从用户输入提取 objective, scope, deliverables |
| ClaimStore | 知识声明存储 — 追踪模型产出的事实断言 |
| Stigmergy | 信息素 — 跨 turn 隐式协调信号 (strength, halfLife, decay) |
| PressureMonitor | 压力监控 — 上下文填充率、验证债务、CVM 开销 |
| ProjectMemory | 项目记忆 — 跨 session 持久化的项目知识 |

### Sensorium (六维感知)

模型通过 6 个 0.0–1.0 连续维度感知自身状态：

- **momentum** — 预测准确率动量
- **pressure** — 多维压力（上下文 50% + 验证债 30% + CVM 15% + 增速 5%）
- **confidence** — 验证覆盖率 (verified / modified)
- **complexity** — 工具多样性 (unique tools / total calls)
- **freshness** — 文件熟悉度（信息素强度，默认 0.5）
- **stability** — 连续稳定性（doom 40% + prediction 25% + diversity 20% + verification 15%）

### Prompt Engine (缓存优化核心)

```
System Prompt = static.ts (固定 anchor, 永不变) + volatile.ts (每 turn 动态组装)
```

- **static.ts** — 基础指令、工具描述、身份。prefix cache 锚点。
- **volatile.ts** — git status, cognitive ledger, tool history, active claims
- **AnchorGraph** — anchor 依赖关系，确保不意外破坏 cache
- **AnchorInvariants** — 强制约束（anchor 不可变、顺序不可变）
- **Fingerprint** — prompt hash，检测 cache invalidation

### Multi-Model Delegation

`src/agent/coordinator.ts`:

- WorkerProfile + WorkOrderScope → 路由到不同 provider/model
- WorkerSession → 独立 worker 执行上下文
- AggregationPolicy → 结果聚合策略

### Compaction (上下文压缩)

`src/compact/`:

| 模块 | 职责 |
|------|------|
| stale-round.ts | 过时轮次检测和压缩 |
| micro.ts | 微压缩（token 级裁剪） |
| semantic-prune.ts | 语义剪枝 |
| staleness-detect.ts | 陈旧度检测 |
| agent-diet.ts | agent 级上下文瘦身 |
| heuristic-*.ts | 启发式提取/注入/存储（跨压缩知识保留） |

### Tools (40+)

bash, edit, read-file, grep, glob, git, apply-patch, delegate-task, delegate-batch, remember, recall, repo-map, repo-graph, run-tests, ask-user-question, todo-store, plan-close, inspect-project, sandbox-exec, process-tracker...

## 关键设计决策

1. **Prefix Cache 是架构级承诺** — 不是优化，是核心约束。所有 prompt 变更通过 AnchorInvariants 验证。

2. **CVM (Cognitive Virtual Machine)** — 模型通过 CognitiveLedger 看到自己的状态（Gen2 paravirtualization），实现自调节。

3. **StarFlow v2** — 运行时 hook pipeline 替代静态 prompt 行为指令，基于实时感知动态调整。

4. **Immutable + Functional** — 全局不可变模式，状态更新返回新对象。

5. **DeepSeek V4 适配** — hasToolJsonInContentBug 修复、RepairPipeline、ctclSanitizerPass。

6. **Multi-Provider** — 支持 OpenAI-compatible（DeepSeek）、Anthropic、Codex 三种 API 协议。

## 目录结构

```
src/
├── agent/        # 主循环、hooks、session、coordinator、星域事件
├── api/          # 多 provider 客户端、流式、重试、错误分类
├── artifact/     # artifact 存储
├── auth/         # API key、OAuth、token store
├── benchmark/    # 性能基准
├── cache/        # cache advisor、审计
├── commands/     # CLI 命令
├── compact/      # 上下文压缩策略
├── config/       # 配置管理
├── context/      # 认知层（ledger、contract、claims、stigmergy）
├── docs/         # 内嵌文档
├── failures/     # 失败处理
├── hooks/        # 外部 hook 注册
├── lsp/          # LSP 集成
├── mcp/          # MCP server 管理
├── model/        # 模型能力卡、路由
├── plan/         # plan mode
├── prompt/       # prompt 引擎（static + volatile + anchor）
├── repo/         # git repo 操作
├── server/       # server mode
├── tools/        # 40+ 工具实现
├── tui/          # Ink 6 UI 组件
├── types/        # 共享类型
├── utils/        # 工具函数
└── workflows/    # workflow 支持
```
