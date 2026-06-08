# P5·Nightcrawler 封存判重证据

> 日期：2026-06-07
> 框架：T2-02 P5 — 空转学习器接通活决策点 v2
> 结论：封存（被 delegate/coordinator 完整覆盖）

## 能力对照

| 语义 | Nightcrawler | Delegate/Coordinator |
|---|---|---|
| Worker profile / tool 权限 | ❌ 无 | ✅ Profile 白名单 |
| 独立 transcript / session 记录 | ❌ 无 | ✅ WorkerSession + worker-*.jsonl |
| Worktree ownership | ❌ 无 | ✅ B1 ownership ledger |
| Verification / delivery gate | ❌ 无 | ✅ deliver_task 门禁 |
| Progress + result aggregation | ⚠️ 只有 status string | ✅ WorkerResult 结构化 |
| Crash/timeout recovery | ⚠️ checkpoint 存在但不完整 | ✅ WorkerSession 重启恢复 |
| Coordinator 调度 | ❌ 进程内 queue | ✅ DelegationCoordinator + batch policy |
| 非 agent 后台任务 | ✅ 可用（telemetry flush, cache warmup） | N/A（coordinator 专为 agent 设计） |

## 判重结论

Nightcrawler 缺少 delegate/coordinator 已具备的 5 项关键工程语义（profile / transcript / ownership / gate / WorkerResult）。作为第二套 agent 执行器会产生无 ownership 的后台 agent，违反 B1 归属约定。

**封存**：保持 Nightcrawler 代码不动，标注为「被 delegate/coordinator 取代的旧调度壳」。若未来需要非 agent 后台任务调度（indexing, cache warmup, telemetry flush），可降级复用。当前不做任何接线。

## 代码锚点

- Nightcrawler 调度器：`src/agent/nightcrawler.ts`
- P3 门面中零调用：`src/agent/p3-integration.ts:42-44`（backgroundExecute 未传）
- Delegate 系统：`src/agent/delegation/`（Coordinator + WorkerSession + worktree ownership）
- B1 归属：`deliver_task` 工具门禁
