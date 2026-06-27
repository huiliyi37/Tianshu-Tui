# 天枢工作流系统分析与优化方向

> 2026-06-27 · 审查天枢子代理/计划/团队/议事会/评审工作流体系,识别优化空间

## 1. 现有工作流体系全景

天枢已有一套**非常完整**的多 agent 工作流体系,远比 Claude Code 的简单 task system 复杂:

### 1.1 五大工作流入口

| 入口 | 工具/命令 | 触发方式 | 核心能力 |
|------|----------|---------|---------|
| **单代理委派** | `delegate_task` | agent 自主调用 | 1 个 worker 执行单个目标 |
| **批量委派** | `delegate_batch` | agent 自主调用 | N 个 worker 并行,5 种聚合策略 |
| **团队编排** | `team_orchestrate` | `/team` 命令 | Plan → wave 分波 → 并行执行 → 合并 |
| **议事会** | `council_convene` | `/council` 命令 | N 席专家单轮会诊 → 计划草案(只读,不执行) |
| **计划模式** | `plan_task` | `/plan` 命令 | 只读探索 → 计划文件 → 可转 team_orchestrate |

### 1.2 底层基础设施

```
Coordinator (coordinator.ts 1809 行)
├── WorkOrder (work-order.ts 981 行) — 工单类型 + 创建/解析/验证
├── WorkOrderQueue (work-queue.ts) — 依赖排序 + 波次调度
├── CollaborationProtocol (283 行) — 语义锁 + 冲突梯度 + 死锁检测 + 合并
├── Aggregation (147 行) — 5 策略 + 验证 gap 检测
├── ProfileRegistry — 7 种 worker profile(readonly/hands/brain/...)
├── ModelTierPolicy — cheap/capable/strong 三档 + Bandit 学习
├── WorkerSession — headless agent 运行 + 持久化 + resume
├── WorkerLiveness — stall 检测 + 超时梯度
└── CircuitBreaker — 连续失败熔断

TeamOrchestrator (team-orchestrator.ts 561 行)
├── TaskPlanner — 目标分解 → TaskGraph DAG
├── TeamGrouping — 文件冲突感知分波
├── TeamSchedulerBandit — 最优并行度学习
├── TeamPerspectives — max 模式三视角 planner fanout
└── ExpertRouter — 星域专家席位动态选择

CouncilOrchestrator (council-orchestrator.ts 220 行)
├── CouncilRouting — 席位 → 星域 authority 路由
├── CouncilPlan — 席位贡献聚合 + 冲突检测
└── CouncilDebate — 多轮 rebuttal(冲突时才触发 round 2)

ReviewRouter (review-router.ts)
├── L1 — 自动审查 nudge(轻量,不阻塞)
├── L2 — 单对抗 verifier(`/review`)
└── L3 — 审查编队 5 inspector(`/review max`)
```

### 1.3 现有问题评估

审查后发现:**核心工作流引擎非常成熟,瓶颈不在引擎而在用户体验和可观测性**。

| 问题域 | 具体问题 | 影响 |
|--------|---------|------|
| **可观测性** | team_orchestrate 的 wave 计划用户看不到(只有最终结果);council 的席位贡献被 `planMerge` 吞掉 | 用户不知道 agent 内部在做什么 |
| **可干预性** | 用户不能中途修改 wave 计划;不能暂停某个 worker;不能手动注入上下文给特定 worker | 大任务失控后只能 abort |
| **计划复用** | plan_task 生成的计划是一次性的;没有计划模板库;不能保存好的计划给未来复用 | 每次从零开始 |
| **工作流组合** | council 和 team 是独立的;council 不能自动触发 team;council → plan → team 需要手动串联 | 工作流断裂 |
| **失败恢复** | worker 失败后只能重试或放弃;没有 checkpoint/resume 整个 wave 的能力 | 长任务中途失败全丢 |
| **进度反馈** | TUI 的 fleet 面板只有最新 activity 行;桌面端的 DelegationSurface 只有树状状态 | 长任务缺乏进度感 |

## 2. 优化方向(按 ROI 排序)

### P0 — 立即做(高价值、中工作量)

#### 2.1 工作流进度可视化(Wave Progress)

**问题**:`team_orchestrate` 执行多 wave 时,用户只看到 "team_orchestrate running",看不到第几 wave、每 wave 多少 task、多少 done/failed/blocked。

**方案**:在 TUI fleet 面板和桌面 DelegationSurface 中,team_orchestrate 执行时渲染 wave 进度条:
```
Team: auth-refactor [Wave 2/3]
  Wave 1: ████████ 8/8 done ✓
  Wave 2: ████░░░░ 3/6 running (2 done, 1 failed, 3 running)
  Wave 3: ░░░░░░░░ pending (4 tasks)
```

数据来源:`TeamRunSummary` 已有 `waves: TeamWave[]`,每个 wave 有 tasks + 状态。需要把 wave 元数据通过 `onProgress` 回调传到 UI。

**工作量**:TUI 3h(fleet 面板增加 wave 区块),桌面 2h(DelegationSurface 加 wave 进度)。**收益**:大任务透明化,用户不焦虑。

#### 2.2 Council → Team 自动衔接

**问题**:`/council` 产出一个计划草案,但用户必须手动复制到 `/team` 执行。council_convene 工具已经输出 `council-plan-json`,但没有自动喂给 team_orchestrate。

**方案**:在 `council_convene` 工具的结果里,如果 council 产出了有效计划,自动追加一行提示:
```
计划已通过议事会审查。使用 /team 执行此计划,或让我自动执行。
```
同时在 `council_convene` 工具内部增加 `autoExecute: boolean` 参数,为 true 时直接调用 `runTeamSkeleton(tasks)`。

**工作量**:2h(council-convene.ts 加 autoExecute 路径 + team-orchestrator.ts 复用已有 `tasks` 输入)。**收益**:工作流从"审查→手动执行"变为"审查→一键执行"。

#### 2.3 Plan → Team 快速路径增强

**问题**:`plan_task` 已经能从计划文件提取 checklist items 转为 team tasks(快路径),但只在计划文件路径匹配 `\.rivet/knowledge/` 或 `docs/superpowers/plans/` 时才触发。用户手写的计划文件路径不匹配就被忽略。

**方案**:放宽 `PLAN_PATH_RE` 正则,接受任何 `.md` 文件路径作为计划文件,只要包含 `- [ ]` checklist 就走快路径。同时增加 `/plan execute <path>` 命令显式触发计划→团队执行。

**工作量**:1h。**收益**:用户的任何 markdown 计划都能一键执行。

### P1 — 短期做(中价值、中工作量)

#### 2.4 计划模板库(Plan Templates)

**问题**:每次计划都从零开始,没有积累。好的计划模式(如"先探索→再分波→最后验证")应该模板化复用。

**方案**:
- `.rivet/plan-templates/*.md` 目录,每个 md = 一个计划模板
- `/plan template <name>` 从模板创建计划骨架
- 模板带 frontmatter: `适用场景` / `预估 wave 数` / `推荐 profile 组合`
- plan_task 完成后提示"保存为模板?"

**工作量**:3h。**收益**:计划复用,团队协作标准化。

#### 2.5 Worker Checkpoint/Resume

**问题**:worker 失败后整个 wave 重跑。但 WorkerSession 已有 `saveWorkerSession` / `loadWorkerSession`(用于单个 worker 的 resume)。缺的是**wave 级别的 checkpoint**。

**方案**:在 WorkOrderQueue 的 wave 调度中,每个 wave 完成后保存 checkpoint(已完成 worker 的 results + 未启动的 tasks)。wave 失败时,用户可以选择"从上一个 checkpoint 恢复"而非全部重跑。

**工作量**:4h。**收益**:长任务失败不全丢。

#### 2.6 实时 Worker 输出流(Live Worker Output)

**问题**:worker 执行时,用户只看到 activity 行(`⚙ grep -r auth`)。看不到 worker 的实际输出(diff/thinking/text)。fleet-detail overlay(刚做的)显示的是快照,不是实时流。

**方案**:利用已有的 `WorkerActivityEvent` stream(`onActivity` 回调),在 fleet-detail overlay 中渲染**实时滚动输出**:
```
┌── AuthLoader (live) ──────────────┐
│ ◐ running · 4.2s                   │
│                                    │
│ ⎿ ⚙ grep -r auth src/              │
│ ⎿ ✓ found 12 files                 │
│ ⎿ ⚙ reading src/auth/login.ts      │
│ ⎿ thinking...                      │
│ ⎿ ⚙ edit_file src/auth/login.ts    │
│                                    │
│ [Esc close]                        │
└────────────────────────────────────┘
```

需要把 `onActivity` 事件的最近 N 条缓存在 FleetRegistry 里(目前只存最新一条)。

**工作量**:3h(FleetRegistry 加 activity ring buffer + fleet-detail overlay 渲染列表)。**收益**:子代理工作完全透明。

### P2 — 中期做(高价值、高工作量)

#### 2.7 工作流编排 DSL(Workflow YAML)

**问题**:team/council/plan 是独立工具,组合它们需要 agent 自己理解语义。复杂工作流(如"council 审查 → team 执行 → review 验证 → 如果失败则 council 重审")无法声明式描述。

**方案**:新增 `.rivet/workflows/*.yaml` 工作流定义文件:
```yaml
name: safe-deliver
steps:
  - id: plan
    tool: council_convene
    input: { objective: "${objective}" }
  - id: execute
    tool: team_orchestrate
    input: { tasks: "${plan.tasks}" }
    depends_on: [plan]
  - id: verify
    tool: deliver_task
    input: { commit: true, review_level: "L3" }
    depends_on: [execute]
    on_failure: plan  # 失败回到 plan 步骤
```
`/workflow <name>` 执行。这把工作流从"agent 自主串联"变为"用户声明式编排"。

**工作量**:1-2 天(DSL 解析 + 执行引擎 + 上下文传递 + 条件分支)。**收益**:复杂工作流可复用、可审计、可分享。

#### 2.8 工作流遥测与回放(Telemetry & Replay)

**问题**:team_orchestrate 执行后,没有结构化的执行记录(哪个 worker 选了什么模型、花了多少、为什么失败)。调试只能靠日志。

**方案**:每个工作流执行自动产出结构化遥测:
- `TeamWaveTelemetry`(已有)记录 wave 级别的并行度/时序/成本
- 新增 `WorkflowTrace`:step-by-step 执行记录(输入/输出/耗时/模型/cost)
- `/workflow replay <trace-id>` 可视化回放某次执行
- 数据存入 `.rivet/traces/`

**工作量**:2-3 天。**收益**:工作流可审计,失败可追溯。

#### 2.9 跨会话 Worker 继承(Cross-Session Worker Inheritance)

**问题**:新会话无法继承上个会话的 worker 上下文。如果上个会话的 worker 做了一半,新会话需要从头开始。

**方案**:`delegate_task` 增加 `inheritFromSession: <sessionId>` 参数,从指定会话加载 worker session 的 messages + context,继续执行。

已有 `resumeWorkOrderId`(单个 worker 级别),这个是扩展到"继承整个会话的 worker fleet"。

**工作量**:2-3 天。**收益**:跨会话连续工作。

## 3. 优先级总结

| 优先级 | 优化 | 目标端 | 工作量 | 核心收益 |
|--------|------|--------|--------|---------|
| **P0** | Wave 进度可视化 | TUI + 桌面 | 5h | 大任务透明化 |
| **P0** | Council → Team 自动衔接 | TUI(引擎) | 2h | 审查→执行一键化 |
| **P0** | Plan → Team 快速路径放宽 | TUI(引擎) | 1h | 任何计划可执行 |
| **P1** | 计划模板库 | TUI + 桌面 | 3h | 计划复用 |
| **P1** | Worker Checkpoint/Resume | TUI(引擎) | 4h | 长任务失败不全丢 |
| **P1** | 实时 Worker 输出流 | TUI | 3h | 子代理完全透明 |
| **P2** | 工作流编排 DSL | TUI + 桌面 | 1-2 天 | 复杂工作流声明式 |
| **P2** | 工作流遥测与回放 | TUI + 桌面 | 2-3 天 | 可审计可追溯 |
| **P2** | 跨会话 Worker 继承 | TUI(引擎) | 2-3 天 | 连续工作 |

## 4. 不建议改的(引擎已足够成熟)

| 不改 | 原因 |
|------|------|
| Coordinator 核心 | 1809 行已极度成熟(EFE 路由 + Bandit + 熔断 + 活性检测) |
| WorkOrder 类型系统 | 981 行 Zod schema 覆盖了所有边缘情况 |
| CollaborationProtocol | 语义锁 + 冲突梯度 + 死锁检测已经很完整 |
| Aggregation 5 策略 | primary_decides / all_required / first_success / majority / weighted_confidence 覆盖全场景 |
| ReviewRouter L1-L3 | 三级审查 + 自动分级已经很合理 |
| ModelTierPolicy | Bandit 学习 + tier lock + shadow controller 是正确的架构 |

**核心判断**:天枢的工作流引擎在 Claude Code 之上(甚至在其之上),不需要重写引擎。优化应聚焦**让用户看到、干预、复用工作流**,而非改造引擎本身。
