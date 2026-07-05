# Plan: plan_task ↔ team_orchestrate 深度统一与运行时闭环

> **目标**：把当前仅完成「UnifiedPlan JSON 自动传递」的 plan bridge，升级为 `plan_task` 与 `team_orchestrate` 共享同一套 **DAG 验证 → 分波 → 执行 → review gate** 路径，补齐端到端测试与 stale-plan 清理。
>
> **预计工期**：5–7 个工作日（1 人）
> **承接状态**：session plan store 桥接已落地（`src/agent/plan-store.ts` 已按会话隔离）

---

## 0. 背景与边界

### 0.1 已完成（不再重复做）

| 项 | 状态 | 关键文件 |
|---|---|---|
| session plan store | ✅ | `src/agent/plan-store.ts` |
| plan_task 写入 store | ✅ | `src/tools/plan-task.ts` |
| team_orchestrate 自动 consume/re-store | ✅ | `src/tools/team-orchestrate.ts` |
| prompt 去掉 JSON 搬运指令 | ✅ | `src/workflows/ecosystem-workflows.ts` |
| plan-store 单测 + 会话隔离 | ✅ | `src/agent/__tests__/plan-store.test.ts` |
| team_orchestrate auto-consume 集成测试 | ✅ | `src/tools/__tests__/team-orchestrate.test.ts` |

### 0.2 当前核心裂缝

1. **两套执行路径**
   - `plan_task(execute: true)` 直接调 `runTeamSkeleton`。
   - `team_orchestrate` 自己调 `DelegationCoordinator.delegateBatch`。
   - 同样的「分波 → 派发 → review gate → telemetry」逻辑写两份，维护成本高。

2. **DAG 验证未共享**
   - `plan_task` 用 `TaskGraph` 做环检测、拓扑排序。
   - `team_orchestrate` 用 `groupTeamTasks` 做文件冲突检测、依赖拓扑。
   - 同一份 `UnifiedPlan` 被两边分别解析，可能产生不一致。

3. **显式 `planJson` 时 session store 不清理**
   - 模型手动传 `planJson` 时，store 里残留的旧 plan 不会被 consume，直到下次 `plan_task` 覆盖。

4. **缺少跨工具端到端测试**
   - 没有 `plan_task` → `team_orchestrate` → `fromWave` 第二波 的完整自动化测试。

### 0.3 不做范围

- 不改造桌面端 UI。
- 不动 prompt / cache 不变量。
- 不引入真 embedding RAG（属于 P2 语义搜索的独立项）。
- 不改动 `council_convene` 的计划交接路径。

---

## 1. 阶段拆解

### Phase 1: 提取共享执行内核 `PlanExecutor`（1.5–2 天）

**目标**：把 `runTeamSkeleton` + 分波 + review gate + telemetry 收敛到一个可复用的执行器。

#### 任务清单

1. 新建 `src/agent/plan-executor.ts`
   - 导出 `executePlan(options: PlanExecutorOptions): Promise<TeamRunSummary>`
   - 内部调用：
     - `unifiedPlanToTeamTasks(plan)`
     - `groupTeamTasks(tasks)` 分波
     - `coordinator.delegateBatch(...)` 派发
     - review gate（如果启用）
     - telemetry / reward closure sink
   - 支持 `fromWave` 参数，支持多 wave 续跑。

2. 重构 `src/tools/plan-task.ts`
   - `execute: true` 分支不再直接 `runTeamSkeleton(...)`，而是：
     ```ts
     const summary = await executePlan({
       plan,
       coordinator: deps.getCoordinator(),
       fromWave: 0,
       sessionId: params.sessionId,
       ...telemetry sinks,
     })
     ```

3. 重构 `src/tools/team-orchestrate.ts`
   - 在 `planJson` / `planMarkdown` 解析出 `UnifiedPlan` 后，统一走 `executePlan(...)`。
   - 移除当前散落在 `execute()` 内的分波、派发、review 代码。

#### 验收

- `plan_task(execute: true)` 和 `team_orchestrate` 的派发路径都经过 `PlanExecutor`。
- 现有 team-orchestrate 测试全部通过，行为不变。

---

### Phase 2: 统一 DAG 验证层（1.5–2 天）

**目标**：`team_orchestrate` 在分波前复用 `TaskGraph` 的验证能力。

#### 任务清单

1. `src/agent/unified-plan.ts`
   - 给 `validateUnifiedPlan` 增加 `dependsOn` 合法性检查（引用的 id 必须存在、无环）。
   - 导出 `unifiedPlanToTaskGraph`（已存在），并确保它返回的 `TaskGraph` 可被 `validateTaskGraph` 消费。

2. `src/agent/task-graph.ts`
   - 把 `validateTaskGraph` 的错误信息结构化，便于工具层返回给模型。

3. `src/tools/team-orchestrate.ts`
   - 在 `deserializeUnifiedPlan` 成功后，先 `unifiedPlanToTaskGraph(plan)`，再 `validateTaskGraph(graph)`。
   - 验证失败返回 `isError: true`，列出具体节点错误。

4. `src/tools/plan-task.ts`
   - 生成 `TaskGraph` 后统一调用 `validateTaskGraph`，错误直接返回给模型。

#### 验收

- `team_orchestrate` 收到非法 `dependsOn` 时返回明确错误。
- `plan-task.test.ts` / `team-orchestrate.test.ts` 各增加 1 个 DAG 验证失败用例。

---

### Phase 3: 端到端桥接测试（1 天）

**目标**：覆盖「plan_task 生成 plan → store → team_orchestrate 消费 → 多 wave 继续」完整链路。

#### 任务清单

1. 新建 `src/tools/__tests__/plan-orchestrate-bridge.test.ts`
   - mock `DelegationCoordinator`，让 `delegateBatch` 返回可控的 worker result。
   - 调用 `createPlanTaskTool(...).execute(...)` 生成并存储 plan。
   - 调用 `createTeamOrchestrateTool(...).execute({ planJson: undefined, fromWave: 0 })` 自动 consume 并派发。
   - 验证第二波 `fromWave: 1` 仍能拿到同一份 plan。

2. 修复/清理测试副作用
   - 测试前用唯一 `sessionId` 调用 `consumePlan(sessionId)` 清 store。
   - 测试后 assert store 被清空或按预期 re-store。

#### 验收

- 新测试文件 ≥ 3 个用例，全部通过。
- 运行命令：
  ```bash
  node --import tsx --test src/tools/__tests__/plan-orchestrate-bridge.test.ts
  ```

---

### Phase 4: stale plan 清理与工程收尾（0.5–1 天）

#### 任务清单

1. `src/tools/team-orchestrate.ts`
   - 当 `planJson` 显式传入且 session store 里存在同 session plan 时，调用 `consumePlan(params.sessionId)` 清理，避免残留。
   - 保持显式 `planJson` 优先级高于 store。

2. `src/agent/plan-store.ts`
   - 可选：增加 `clearPlan(sessionId?: string)` 用于显式清理，减少 magic `consumePlan` 误用。

3. 日志与错误提示
   - `team_orchestrate` 在 store 为空且 `planJson` 省略、又无 `planPath`/`planMarkdown` 时，返回更明确的错误：
     > "No plan provided and no stored plan found. Run plan_task first or pass planJson/planPath."

#### 验收

- 新增一个测试：显式 `planJson` 时，session store 被清空。
- typecheck 无新增错误。

---

### Phase 5: 回归验证（0.5–1 天）

#### 任务清单

1. `npm run typecheck`
2. 跑完整相关测试：
   ```bash
   node --import tsx --test \
     src/agent/__tests__/plan-store.test.ts \
     src/agent/__tests__/task-graph.test.ts \
     src/agent/__tests__/task-planner.test.ts \
     src/tools/__tests__/plan-task.test.ts \
     src/tools/__tests__/team-orchestrate.test.ts \
     src/tools/__tests__/plan-orchestrate-bridge.test.ts
   ```
3. 手动走一遍 `/team` 或 `/plan` 工作流实跑验证。

---

## 2. 任务顺序与依赖

| 天数 | 任务 | 依赖 | 产出 |
|---|---|---|---|
| D1 | 新建 `PlanExecutor` 骨架 | 无 | `src/agent/plan-executor.ts` |
| D2 | plan_task / team_orchestrate 接入 `PlanExecutor` | D1 | 两工具走同一执行路径 |
| D3 | 统一 DAG 验证 | D2 | `validateTaskGraph` 共享 |
| D4 | 端到端桥接测试 | D2-D3 | `plan-orchestrate-bridge.test.ts` |
| D5 | stale plan 清理 + 错误提示 | D2 | 显式 planJson 清理 store |
| D6 | 回归：typecheck + 测试 + 实跑 | 全部 | 验收报告 |

---

## 3. 风险与预案

| 风险 | 预案 |
|---|---|
| `PlanExecutor` 提取时引入行为回归 | 先保留旧代码分支，通过 flag 切换，测试全绿后再删除旧分支 |
| `plan_task(execute: true)` 原来直接 `runTeamSkeleton`，改成 `PlanExecutor` 后 coordinator 获取时机变化 | `createPlanTaskTool` 的 `getCoordinator` 已经提供，直接透传 |
| `groupTeamTasks` 与 `TaskGraph` 验证语义不完全一致 | 提取 adapter：`unifiedPlanToTaskGraph` 已存在，只补合法性检查 |
| 多 wave 测试难 mock | 用固定返回值的 `delegateBatch` stub，控制 `fromWave` 行为 |

---

## 4. 验收标准（整体 done 定义）

- [ ] `plan_task(execute: true)` 与 `team_orchestrate` 共享 `PlanExecutor`，没有重复的分波/派发代码。
- [ ] 同一份 `UnifiedPlan` 的 DAG 验证在两边一致。
- [ ] 新增 `plan-orchestrate-bridge.test.ts` 且通过。
- [ ] 显式 `planJson` 时，对应 session 的 store plan 被清理。
- [ ] `npm run typecheck` 无新增错误，相关测试全绿。
- [ ] 手动 `/team` 或 `/plan` 工作流能跑完多 wave。

---

## 5. 关联文档

| 文档 | 路径 |
|---|---|
| 已完成的 session plan store 桥接 | `.rivet/plans/天枢-plan-task-team-orchestrate-自动桥接-session-plan-store.md` |
| 更深统一的设计 | `.rivet/plans/t11-深化-四领域架构统一设计.md` |
| UnifiedPlan 类型与转换 | `src/agent/unified-plan.ts` |
| 当前 plan bridge 实现 | `src/agent/plan-store.ts`、`src/tools/plan-task.ts`、`src/tools/team-orchestrate.ts` |
