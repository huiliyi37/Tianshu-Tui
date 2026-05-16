# Wave 7: Sub-Agent 接线增强 — 设计文档

## 背景

Rivet 已有完整的 coordinator/worker/aggregation 架构（`src/agent/coordinator.ts`、`worker-session.ts`、`work-order.ts`、`aggregation.ts`），但审计发现 10 个断点让系统形同虚设：

- `delegate_task` 硬编码为 `code_search` + `code_scout`，6 种 kind/profile 未暴露
- Worker 只有 read-only 工具，`WRITE_WORKER_TOOLS` 已定义未使用
- Worker 结果不进入 claim store
- Goal loop 无 delegation 能力
- Worker 不继承父 context
- `CoordinatorState.shouldEscalate()` 未被调用
- `delegateBatch` 并行能力存在但无入口

## 目标

把 coordinator 从 demo 级提升到生产级。不写新架构，只接线。完成后 Rivet 的 sub-agent 能力从"只能 code_search"变成"6 种 worker + 可写 + 并行 + claim 回流 + 失败升级"。

## 设计

### A1: delegate_task 支持 kind/profile 参数

**现状：** `delegate-task.ts:49` 硬编码 `kind: 'code_search'`, `profile: 'code_scout'`。

**变更：** tool input schema 增加可选 `kind` 和 `profile` 字段，默认保持 `code_search`/`code_scout`。Agent 可根据任务选择：

```
kind: code_search | code_review | refactor | test_generation | documentation | planning
profile: code_scout | reviewer | patcher | test_writer | doc_writer | planner
```

### A2: Worker 可选写入工具

**现状：** `runtimeFactory` 硬编码 `READ_ONLY_WORKER_TOOLS`。`WRITE_WORKER_TOOLS` 已定义未使用。

**变更：** `runtimeFactory` 根据 `order.profile` 选择工具集：
- `code_scout`/`reviewer`/`planner` → `READ_ONLY_WORKER_TOOLS`
- `patcher`/`test_writer`/`doc_writer` → `WRITE_WORKER_TOOLS`

写入 worker 的 `maxTurns` 从 4 提升到 8。

### A3: Worker 结果 → claim proposal

**现状：** Worker 结果作为纯文本 `tool_result` 返回，不触发 claim 提取。

**变更：** 在 `delegate-task.ts` 的 `execute()` 中，worker 返回后：
1. 从 `WorkerResult.findings` 中提取 claims（每个 finding → `worker_finding` kind claim）
2. 写入主 agent 的 `contextClaimStore`
3. 主 agent 下一轮 prompt 中可见这些 claims

Evidence 链路：`worker finding → claim proposal → claim store → active claims → prompt`

### A4: Goal loop 注入 coordinator

**现状：** Goal loop 的 `createAgent` 不注册 `delegate_task`，不创建 coordinator。

**变更：** Goal loop 的 agent 配置中：
1. 创建 `DelegationCoordinator` 实例
2. 注册 `delegate_task` 到 toolRegistry
3. Agent 在自主循环中可以 delegate 子任务

### A5: 并行 delegation

**现状：** `isConcurrencySafe: false` 阻止并行。`delegateBatch` 无 tool 入口。

**变更：**
1. `isConcurrencySafe: true`（允许 agent loop 并行调度）
2. 新增 `delegate_batch` tool，接受 `tasks[]` 参数，调用 `coordinator.delegateBatch()`
3. `maxWorkers` 提升到 3

### A6: Worker 继承父 active claims

**现状：** Worker 创建空 `SessionContext`，无法利用主 agent 已积累的上下文。

**变更：** Worker 启动时：
1. 从主 agent 的 claim store 读取 active claims
2. 通过 `promptEngine.updateActiveClaims()` 注入 worker 的 volatile context
3. Worker 看到主 agent 积累的用户约束和决策（read-only，不写回）

### A7: 失败梯度 + shouldEscalate

**现状：** `CoordinatorState.shouldEscalate()` 已实现但未被调用。

**变更：** `coordinator.delegate()` 中：
1. Worker 失败时调用 `state.recordFailure()`
2. 检查 `state.shouldEscalate()`：
   - 未升级 → retry（同 model）
   - 升级 → 返回 `{ status: 'escalated', reason }` 让主 agent 决定下一步
3. 最大重试次数 = 2（含首次 = 3 次机会）

## 验收标准

| 标准 | 验证 |
|------|------|
| Agent 可指定 worker kind/profile | delegate_task input 含 kind 参数 |
| patcher worker 能 edit/write 文件 | worker 执行 edit_file 成功 |
| Worker findings 进入 claim store | /context 显示 worker_finding claims |
| Goal loop 中可 delegate | --goal 模式下 agent 调用 delegate_task |
| 并行 delegation 可用 | delegate_batch 同时跑 2+ workers |
| Worker 看到父 claims | worker prompt 中包含 active-claims block |
| 连续失败触发升级 | 3 次失败后返回 escalated status |
| 所有测试通过 | 760+ pass, 0 fail |

## 后续（Wave 8 候选）

- Brain/Hands 分离：Brain 只持有 delegate_task + think，Hands 执行具体工具
- Git worktree 隔离：write worker 在独立 worktree 执行，diff 回流
- Worker 间共享 knowledge base（session-memory read-only 投影）
