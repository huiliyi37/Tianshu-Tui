# LLM 驱动的执行计划轨迹（U6 / C1）

> 让 agent 在 planning 阶段产出的「有序步骤」成为一份可追踪的执行计划基线（`PlanExecutionTrace`），由 `ReplanLoop` 在每个回合边界对照基线检测偏差并自主纠偏——**零新工具、零强制行为、缓存无损**。

## 1. 动机

U1/U2 已构建 `PlanExecutionTrace`（计划执行轨迹数据模型）与 `ReplanLoop`（偏差检测 + 自主修正），但缺一个**生产者**：谁来把 LLM 的规划意图变成结构化的 `PlanStep[]`？这是 W4 前遗留的 C1 缺口。

候选方案是新增独立 `plan_steps` 工具，但默认注册表常驻已 24 个工具，再加一个会顶到 kernel budget 上限 25（`kernel-budget.test.ts`），违背「工具 >25 → 选择过载退化」哲学。

**关键发现**：`todo` 工具的结构 `{id, content, status}` 与 `PlanStep` 几乎同构，且 **agent 处理多步任务本就会调 `todo write` 列出有序清单**。于是 C1 改为**从首次 `todo write` 派生计划基线**——复用既有行为，零预算成本，高采纳率。

## 2. 关键概念

| 概念 | 含义 |
|------|------|
| `PlanExecutionTrace` | 任务级执行轨迹：`{contractId, depthLayer, steps[], history[], status}`。任务启动时按 task contract 创建（`createTrace`）。 |
| 计划基线（baseline） | 首次非空 `todo write` 派生的 `PlanStep[]`。**`withPlanSteps` 幂等**——只有第一次写入填充基线，后续状态更新写入对 trace 无副作用。 |
| `onPlanSteps` 回调 | `todo write` 时把 `todos.map(t => t.content)` 上抛给 loop 的回调（**复用 `leave_mark` 的 `onLeaveMark` 先例**）。 |
| `expectedTools` | 每步预期工具，由 `inferExpectedTools()` 从描述关键词自动推断（含 LSP 触发词）。模型只产「描述」，不产工具。 |
| `depthLayer` | 任务深度（`unit`/`wiring`/`system`），决定步数上限（3/5/8）。由 loop 持有，工具只传描述。 |
| 偏差（deviation） | `ReplanLoop.detectDeviation` 产出的 5 类：`none`/`blocked`/`stalled`/`deviated`/`replanned`。 |

## 3. 架构与数据流

```
planning 阶段：plan-methodology advisory 轻提示「先用 todo 列出有序步骤」
   │
   ▼
模型调 todo write {todos:[{content}, …]}
   │   todo.execute → params.onPlanSteps?.(todos.map(t=>t.content))
   ▼
loop.capturePlanSteps(descriptions)
   │   buildPlanSteps(descriptions, depthLayer)   # 描述 → PlanStep[]（推断 expectedTools、按深度截断）
   │   withPlanSteps(trace, steps)                # 幂等填入基线
   ▼
每个 tool-turn 结束：buildStepResultFromTurn(turn) → appendResult(trace, …)   # 推进 active step / 标记失败
   │
   ▼
回合边界（convergence 之后）：runReplanCheck()
   ├─ detectDeviation(trace, lastResult, convergenceLevel, noToolTurns)
   ├─ deviation ≠ none → correctPlan + injectReplanContext
   │        └─► system-reminder 注入（中途纠偏，去重）
   └─ setPlanTraceAppendix(serializeTrace(trace))   # 跨用户边界持久化（缓存安全）
```

## 4. 模块清单

| 文件 | 职责 |
|------|------|
| `src/agent/plan-execution-trace.ts` | `buildPlanSteps`（描述→`PlanStep[]`，推断 `expectedTools` + 按 `depthLayer` 截断）、`withPlanSteps`（幂等填基线）、`inferExpectedTools`、`serializeTrace`、`appendResult`、`createTrace`。 |
| `src/tools/todo.ts` | `write` 动作末尾 `params.onPlanSteps?.(data.todos.map(t => t.content))`——派生入口。 |
| `src/tools/types.ts` | `ToolCallParams.onPlanSteps?`（镜像 `onLeaveMark`）。 |
| `src/agent/tool-pipeline.ts` / `tool-execution.ts` | `onPlanSteps?` 透传链路（deps 装配）。 |
| `src/agent/loop-factory.ts` | 把 `onPlanSteps: d => self.capturePlanSteps(d)` 接入工具执行控制器。 |
| `src/agent/loop.ts` | `planTrace` 字段 + `capturePlanSteps` / `buildStepResultFromTurn` / `runReplanCheck`；run 循环里 `appendResult` + `runReplanCheck` 接线。 |
| `src/agent/replan-loop.ts` | `nextStepId(trace)` 改为 trace-local（消除模块级 `stepCounter` 并发隐患）。 |
| `src/prompt/engine.ts` / `volatile.ts` | `planTraceAppendix` 渲染 + GWT 显式 salience；`plan-methodology` 模板尾部加 todo 轻提示。 |

## 5. C1 派生机制（零新工具）

```
todo.execute(action='write', todos):
  store.write(todos)
  if params.onPlanSteps && todos.length > 0:
    params.onPlanSteps(todos.map(t => t.content))   # 只传描述

loop.capturePlanSteps(descriptions):
  if !planTrace: return                              # 无活跃任务 → 不派生
  planTrace = withPlanSteps(planTrace,
                buildPlanSteps(descriptions, planTrace.depthLayer))
```

- **模型只需产「todo 描述」**，`expectedTools` 由 `inferExpectedTools()`（LSP 关键词：理解/追踪/调用方/依赖/… → `lsp_find_references` + `lsp_goto_definition`）自动推断。
- `buildPlanSteps` 按 `depthLayer` 截断（unit=3 / wiring=5 / system=8），过滤空描述，生成顺序 `step-N` id。
- `withPlanSteps` 幂等：`trace.steps` 或 `history` 非空时直接返回原 trace——**首份 todo 即基线**，后续 `todo write`（勾选完成、增删项）不会覆盖计划基线。

## 6. 偏差检测与纠偏（回合边界）

`runReplanCheck()` 在 `runConvergenceCheck` 之后、`buildTurnRequest` 之前运行（确保消费到最新 `latestConvergenceResult`）：

```
runReplanCheck():
  if !planTrace || steps.length === 0: return         # 无计划 → 完全 no-op（零回归）
  deviation = detectDeviation(trace, lastResult,
                latestConvergenceResult.level, consecutiveNoToolTurns)
  if deviation ≠ none:
    {trace, addedSteps} = correctPlan(trace, deviation)
    ctx = injectReplanContext(deviation, addedSteps)
    if ctx.text ≠ lastReplanInjection:                # 去重
      session.addUserMessage(wrapSystemReminder(ctx.text))   # 中途纠偏
  setPlanTraceAppendix(serializeTrace(trace))         # 跨边界持久化
```

- `buildStepResultFromTurn(turn)` 从 `traceStore.events` 抽取该回合工具调用，映射到首个 active/pending 步（顺序推进），任一工具 `failed`/`blocked` → 整步标记 `blocked`。无工具回合返回 null。
- **降级保证**：模型若从不调 `todo write`（简单单文件任务 / 纯聊天）→ `steps` 恒空 → `runReplanCheck` 直接 return，`detectDeviation` 只剩既有 `blocked`/`stalled` 路径。**零回归，不强制每个任务都分解。**

## 7. 两条注入通路（为什么分开）

U6 的核心架构抉择：纠偏文本走**哪条**通路进入提示。

| 通路 | 用途 | 时机 | 缓存语义 |
|------|------|------|----------|
| **system-reminder**（`wrapSystemReminder` + `session.addUserMessage`） | 中途纠偏，必须**本回合**抵达模型 | 检测到偏差时 | 原样透传进历史（`engine.ts` 对 system-reminder 不做 trailer 合并），单回合内即可见 |
| **plan-trace appendix**（`setPlanTraceAppendix`） | 计划基线 + 进度，跨用户边界/压缩存活 | 每个回合边界刷新 | 写入动态 appendix，**下一个用户消息边界**才生效 |

**为什么不能只用 appendix**：动态 appendix 在单条用户消息内是**冻结**的（前缀缓存稳定性，`engine.ts` 仅当 last user message 内容变化时重算 `cachedAppendix`）。任务进行中的多个回合共享同一条用户消息，`setPlanTraceAppendix` 不会进入同轮请求。因此中途纠偏必须借 system-reminder（与收敛检测同机制），appendix 只负责跨边界持久化。

> `lastReplanInjection` 去重：偏差若持续多回合存在，同一纠偏文本只注入一次，防止刷屏。

## 8. 并发安全（`nextStepId` trace-local）

W6e 修复历史技术债：`replan-loop.ts` 原有模块级 `let stepCounter` 全局可变状态，多 trace / 多会话并发时步 ID 会交叉污染。

```
nextStepId(trace):
  existing = trace.steps.filter(s => s.id.startsWith('replan-')).length
  return `replan-${existing + 1}`
```

改为纯函数：从**该 trace 自身**已有的 `replan-*` 步计数派生，去除全局可变状态。两个并发 trace 各自从 `replan-1` 起算，互不交叉、互不清零。

## 9. 缓存安全

- 计划基线 / 进度只进**动态 appendix**（在消息历史之后，前缀稳定），不改写历史、不在 anchor 前注入。
- 中途纠偏走 system-reminder——这是 anchor 后追加的独立用户消息，对既有前缀字节稳定，不破坏 DeepSeek V4 前缀缓存（与收敛警告完全同模式）。
- `plan-execution-trace` 在 GWT Top-K 选择中获显式 salience `0.7`，预算紧张时不被丢弃。

## 10. planning 提示引导（可选优化）

`plan-methodology` advisory 两个模板（lightweight / full）尾部追加一句「开工前先用 todo 列出有序步骤（即为执行计划基线）」。仅在 loop 分类出 methodology（actionable 多步任务）时渲染——简单任务不受打扰。属采纳率优化，非通电必需（agent 本就调 todo）。

## 11. 测试

| 套件 | 覆盖 |
|------|------|
| `plan-execution-trace.test.ts` | `buildPlanSteps`（顺序 id / `inferExpectedTools` / 按深度截断 / 过滤空白）+ `withPlanSteps`（幂等）。 |
| `todo.test.ts`（`onPlanSteps` 组） | `write` 调 `onPlanSteps` 且 content 顺序正确；`read` 不调；空列表不调；无回调时静默降级。 |
| `replan-loop.test.ts` | `nextStepId` trace-local——并发 trace 步 ID 不交叉、不互相清零。 |
| `volatile.test.ts`（U6 组） | `planTraceAppendix` 渲染进动态 appendix；未设置时无空标记。 |
| `trace-integration.test.ts` | **Layer 1**：loop 组合次序的纯函数生命周期（seed→advance→blocked/stalled/replanned→serialize）+ 反证。**Layer 2**：活 `AgentLoop` 接线——脚本化模型调 `todo write`，spy `setPlanTraceAppendix` 验证端到端链路 `todo → onPlanSteps → capturePlanSteps → appendResult → serializeTrace → engine`。 |

> **测试设计要点**：Layer 2 断言**持久化面**（`setPlanTraceAppendix` 收到序列化 trace），而非模型请求文本。因 appendix 单回合冻结，序列化 trace 不出现在同回合请求里（中途纠偏改走 system-reminder）；spy 持久化面可证全链路而不耦合缓存时序与 per-task contract-id 重置。
